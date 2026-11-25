import uuid
from datetime import timezone as dt_timezone

from django.db import transaction
from django.db.models import F
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.generics import RetrieveAPIView
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

from core.exceptions import ApiError
from core.pagination import ItemsPagination
from core.permissions import IsSeller
from payments.models import PaymentTransaction
from products.models import Product

from .models import Order, OrderItem
from .serializers import CreateOrderSerializer, OrderSerializer


def _parse_iso_bound(value, field):
    """Parse an ISO 8601 `since`/`until` query bound, or raise a 422.

    Naive timestamps (no offset) are treated as UTC so the comparison against
    the stored, timezone-aware `created_at` is always valid.
    """
    if not value:
        return None
    parsed = parse_datetime(value)
    if parsed is None:
        raise ApiError(
            f"'{field}' must be an ISO 8601 timestamp.",
            code="VALIDATION_ERROR",
            status_code=422,
            field_errors={field: "Use an ISO 8601 timestamp (e.g. 2024-02-15T10:30:00Z)."},
        )
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, dt_timezone.utc)
    return parsed


class OrderListCreateView(APIView):
    def get(self, request):
        qs = Order.objects.filter(buyer=request.user).prefetch_related("items")
        page = ItemsPagination()
        page_qs = page.paginate_queryset(qs, request)
        return page.get_paginated_response(OrderSerializer(page_qs, many=True).data)

    def post(self, request):
        ser = CreateOrderSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        payment_reference = data.get("payment_reference")

        with transaction.atomic():
            product_ids = [i["product_id"] for i in data["items"]]
            products = {
                p.id: p for p in Product.objects.select_for_update().filter(id__in=product_ids, status="active")
            }
            missing = set(product_ids) - set(products)
            if missing:
                raise ApiError("One or more items are no longer available.", code="PRODUCT_UNAVAILABLE", status_code=422)

            total = 0
            rows = []
            for line in data["items"]:
                product = products[line["product_id"]]
                qty = line["quantity"]
                if product.stock < qty:
                    raise ApiError(
                        f'Only {product.stock} left of "{product.name}".',
                        code="INSUFFICIENT_STOCK", status_code=422,
                    )
                unit_price = product.display_price
                line_total = unit_price * qty
                total += line_total
                rows.append((product, qty, unit_price, line_total))

            payment_txn = None
            if payment_reference:
                payment_txn = PaymentTransaction.objects.select_for_update().filter(
                    reference=payment_reference
                ).first()
                if payment_txn is None or payment_txn.status != "success":
                    raise ApiError(
                        "We couldn't verify that payment. Please try again.",
                        code="PAYMENT_NOT_VERIFIED", status_code=422,
                    )
                if payment_txn.order_id is not None:
                    raise ApiError(
                        "This payment has already been used for another order.",
                        code="PAYMENT_ALREADY_USED", status_code=422,
                    )
                if int(payment_txn.amount) != int(total):
                    raise ApiError(
                        "The amount paid does not match the order total.",
                        code="PAYMENT_AMOUNT_MISMATCH", status_code=422,
                    )

            buyer = request.user
            order = Order.objects.create(
                id=uuid.uuid4(), buyer=buyer, reference=f"UNI-{uuid.uuid4().hex[:10].upper()}",
                buyer_name=buyer.full_name, buyer_initials=(buyer.full_name[:1] or "?").upper(),
                delivery_address=data.get("delivery_address", ""), delivery_phone=data.get("delivery_phone", ""),
                amount=total, status="paid" if payment_txn else "pending",
                payment_reference=payment_reference,
            )
            for product, qty, unit_price, line_total in rows:
                OrderItem.objects.create(
                    id=uuid.uuid4(), order=order, product=product, seller_id=product.seller_id,
                    product_name=product.name, quantity=qty, unit_price=unit_price, line_total=line_total,
                )
                # Stock is reserved immediately, but `sold_count` only moves at
                # confirmation: a pending order must not count as sold yet.
                product.stock -= qty
                product.save(update_fields=["stock"])

            if payment_txn:
                payment_txn.order = order
                payment_txn.save(update_fields=["order"])

        return Response(OrderSerializer(order).data, status=status.HTTP_201_CREATED)


class OrderDetailView(RetrieveAPIView):
    serializer_class = OrderSerializer

    def get_queryset(self):
        return Order.objects.filter(buyer=self.request.user).prefetch_related("items")


class SellerOrdersView(APIView):
    permission_classes = [IsSeller]

    def get(self, request):
        """Orders that include at least one item sold by this seller."""
        order_ids = OrderItem.objects.filter(seller=request.user).values_list("order_id", flat=True).distinct()
        qs = Order.objects.filter(id__in=order_ids).prefetch_related("items")

        # Notification bell: only orders still awaiting the seller's confirmation.
        confirmation = request.query_params.get("confirmation")
        if confirmation:
            if confirmation not in {"pending", "confirmed"}:
                raise ApiError(
                    "'confirmation' must be either 'pending' or 'confirmed'.",
                    code="VALIDATION_ERROR",
                    status_code=422,
                    field_errors={"confirmation": "Use 'pending' or 'confirmed'."},
                )
            qs = qs.filter(confirmation=confirmation)

        # Sales Analytics windows (inclusive) so the client does not download
        # the seller's entire order history.
        since = _parse_iso_bound(request.query_params.get("since"), "since")
        until = _parse_iso_bound(request.query_params.get("until"), "until")
        if since is not None:
            qs = qs.filter(created_at__gte=since)
        if until is not None:
            qs = qs.filter(created_at__lte=until)

        page = ItemsPagination()
        page_qs = page.paginate_queryset(qs, request)
        return page.get_paginated_response(OrderSerializer(page_qs, many=True).data)


class SellerOrderConfirmView(APIView):
    """Seller confirms an order was actually made.

    Only a seller with at least one line item on the order may confirm it;
    everyone else (including buyers and other sellers) gets a 404, matching the
    anti-enumeration stance of the rest of the orders API. Confirming twice is
    idempotent. The order starts counting toward revenue and products sold only
    once this succeeds.
    """

    permission_classes = [IsSeller]

    def post(self, request, pk):
        with transaction.atomic():
            order = (
                Order.objects.select_for_update()
                .prefetch_related("items")
                .filter(pk=pk)
                .first()
            )
            if order is None or not any(
                item.seller_id == request.user.id for item in order.items.all()
            ):
                raise ApiError("Order not found.", code="NOT_FOUND", status_code=404)

            if order.confirmation != "confirmed":
                order.confirmation = "confirmed"
                order.confirmed_at = timezone.now()
                order.save(update_fields=["confirmation", "confirmed_at", "updated_at"])
                # The denormalized "sold" counter moves here, not at checkout,
                # so pending orders never look sold on public product listings.
                for item in order.items.all():
                    if item.product_id:
                        Product.objects.filter(pk=item.product_id).update(
                            sold_count=F("sold_count") + item.quantity
                        )

        return Response(OrderSerializer(order).data)

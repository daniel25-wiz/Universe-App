import uuid
from datetime import timedelta
from decimal import Decimal

from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from accounts.models import User
from products.models import Product

from .models import Order, OrderItem


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class OrderConfirmationTests(APITestCase):
    """Seller order-confirmation contract.

    A buyer order is `confirmation: "pending"` on creation and is excluded from
    the seller's revenue / products sold until the seller confirms it. Only a
    seller with a line item on the order may confirm it, and confirming twice
    must not double-count.
    """

    def setUp(self):
        self.buyer = User.objects.create_user(
            email="buyer@example.com", password="password123",
            full_name="Buyer One", account_type="buyer",
        )
        self.seller = User.objects.create_user(
            email="seller@example.com", password="password123",
            full_name="Seller One", account_type="seller",
        )
        self.other_seller = User.objects.create_user(
            email="other@example.com", password="password123",
            full_name="Seller Two", account_type="seller",
        )
        self.product = Product.objects.create(
            seller=self.seller, name="Minimalist Ceramic Mug",
            price=Decimal("100.00"), stock=20, status="active",
        )

    # --- helpers ---------------------------------------------------------
    def make_order(self, *, seller=None, product=None, confirmation="pending",
                   quantity=1, created_at=None):
        seller = seller or self.seller
        product = product or self.product
        order = Order.objects.create(
            buyer=self.buyer,
            reference=f"UNI-{uuid.uuid4().hex[:10].upper()}",
            buyer_name=self.buyer.full_name,
            buyer_initials="B",
            amount=product.price * quantity,
            status="paid",
            confirmation=confirmation,
        )
        OrderItem.objects.create(
            order=order, product=product, seller=seller,
            product_name=product.name, quantity=quantity,
            unit_price=product.price, line_total=product.price * quantity,
        )
        if created_at is not None:
            Order.objects.filter(pk=order.pk).update(created_at=created_at)
        return Order.objects.get(pk=order.pk)

    # --- creation --------------------------------------------------------
    def test_new_order_starts_pending_and_does_not_count_as_sold(self):
        self.client.force_authenticate(user=self.buyer)
        response = self.client.post(
            "/api/orders",
            {"items": [{"product_id": str(self.product.id), "quantity": 2}],
             "delivery_address": "1 Test Street"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["confirmation"], "pending")
        self.assertIsNone(response.data["confirmed_at"])
        self.assertEqual(response.data["status"], "pending")

        self.product.refresh_from_db()
        self.assertEqual(self.product.stock, 18)  # reserved at checkout
        self.assertEqual(self.product.sold_count, 0)  # not sold until confirmed

    # --- seller list filters --------------------------------------------
    def test_pending_filter_returns_only_unconfirmed_orders(self):
        pending = self.make_order(confirmation="pending")
        self.make_order(confirmation="confirmed")

        self.client.force_authenticate(user=self.seller)
        response = self.client.get("/api/seller/orders?confirmation=pending")

        self.assertEqual(response.status_code, 200)
        ids = [item["id"] for item in response.data["items"]]
        self.assertEqual(ids, [str(pending.id)])
        self.assertEqual(response.data["total"], 1)

    def test_confirmed_filter_returns_only_confirmed_orders(self):
        self.make_order(confirmation="pending")
        confirmed = self.make_order(confirmation="confirmed")

        self.client.force_authenticate(user=self.seller)
        response = self.client.get("/api/seller/orders?confirmation=confirmed")

        self.assertEqual(response.status_code, 200)
        ids = [item["id"] for item in response.data["items"]]
        self.assertEqual(ids, [str(confirmed.id)])

    def test_invalid_confirmation_filter_is_rejected(self):
        self.client.force_authenticate(user=self.seller)
        response = self.client.get("/api/seller/orders?confirmation=maybe")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.data["code"], "VALIDATION_ERROR")
        self.assertIn("confirmation", response.data["field_errors"])

    def test_since_until_window_filters_by_created_at(self):
        now = timezone.now()
        inside = self.make_order(created_at=now - timedelta(days=1))
        self.make_order(created_at=now - timedelta(days=10))

        self.client.force_authenticate(user=self.seller)
        response = self.client.get(
            "/api/seller/orders",
            {"since": (now - timedelta(days=2)).isoformat(),
             "until": now.isoformat()},
        )

        self.assertEqual(response.status_code, 200)
        ids = [item["id"] for item in response.data["items"]]
        self.assertEqual(ids, [str(inside.id)])

    def test_invalid_since_is_rejected(self):
        self.client.force_authenticate(user=self.seller)
        response = self.client.get("/api/seller/orders?since=yesterday")
        self.assertEqual(response.status_code, 422)
        self.assertIn("since", response.data["field_errors"])

    def test_seller_only_sees_orders_containing_their_own_items(self):
        mine = self.make_order()
        other_product = Product.objects.create(
            seller=self.other_seller, name="Other Mug",
            price=Decimal("50.00"), stock=5, status="active",
        )
        self.make_order(seller=self.other_seller, product=other_product)

        self.client.force_authenticate(user=self.seller)
        response = self.client.get("/api/seller/orders")
        ids = [item["id"] for item in response.data["items"]]
        self.assertEqual(ids, [str(mine.id)])

    # --- confirmation ----------------------------------------------------
    def test_seller_can_confirm_and_sold_count_moves_at_confirmation(self):
        order = self.make_order(quantity=2)
        self.product.refresh_from_db()
        self.assertEqual(self.product.sold_count, 0)

        self.client.force_authenticate(user=self.seller)
        response = self.client.post(f"/api/seller/orders/{order.id}/confirm")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["confirmation"], "confirmed")
        self.assertIsNotNone(response.data["confirmed_at"])

        order.refresh_from_db()
        self.assertEqual(order.confirmation, "confirmed")
        self.assertIsNotNone(order.confirmed_at)
        self.product.refresh_from_db()
        self.assertEqual(self.product.sold_count, 2)

    def test_confirmation_is_idempotent_and_does_not_double_count(self):
        order = self.make_order(quantity=3)

        self.client.force_authenticate(user=self.seller)
        first = self.client.post(f"/api/seller/orders/{order.id}/confirm")
        second = self.client.post(f"/api/seller/orders/{order.id}/confirm")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.data["confirmation"], "confirmed")
        self.product.refresh_from_db()
        self.assertEqual(self.product.sold_count, 3)

    def test_other_seller_gets_404(self):
        order = self.make_order()
        self.client.force_authenticate(user=self.other_seller)
        response = self.client.post(f"/api/seller/orders/{order.id}/confirm")
        self.assertEqual(response.status_code, 404)
        order.refresh_from_db()
        self.assertEqual(order.confirmation, "pending")

    def test_buyer_cannot_confirm(self):
        order = self.make_order()
        self.client.force_authenticate(user=self.buyer)
        response = self.client.post(f"/api/seller/orders/{order.id}/confirm")
        self.assertEqual(response.status_code, 403)
        order.refresh_from_db()
        self.assertEqual(order.confirmation, "pending")

    def test_missing_order_gets_404(self):
        self.client.force_authenticate(user=self.seller)
        response = self.client.post(f"/api/seller/orders/{uuid.uuid4()}/confirm")
        self.assertEqual(response.status_code, 404)

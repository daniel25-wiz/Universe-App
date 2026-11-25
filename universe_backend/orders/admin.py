from django.contrib import admin

from .models import Order, OrderItem


class OrderItemInline(admin.TabularInline):
    model = OrderItem
    extra = 0


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ("reference", "buyer", "amount", "status", "confirmation", "created_at")
    list_filter = ("status", "confirmation")
    search_fields = ("reference", "buyer__email", "payment_reference")
    readonly_fields = ("confirmed_at",)
    inlines = [OrderItemInline]

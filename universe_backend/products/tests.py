from django.test import TestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from accounts.models import User
from .views import ProductListCreateView


class ProductCreateTests(TestCase):
    def test_null_variants_are_saved_as_empty_list(self):
        seller = User.objects.create_user(
            email="seller@example.com",
            password="test-password",
            full_name="Test Seller",
            account_type="seller",
        )
        request = APIRequestFactory().post(
            "/api/products",
            {"name": "Test product", "price": "12.50", "variants": None},
            format="json",
        )
        force_authenticate(request, user=seller)

        response = ProductListCreateView.as_view()(request)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["variants"], [])

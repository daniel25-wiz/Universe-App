from types import SimpleNamespace
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from .views import UploadImageView


class UploadImageViewTests(SimpleTestCase):
    def test_saves_image_with_default_storage_and_returns_storage_url(self):
        image = SimpleUploadedFile("original.png", b"image data", content_type="image/png")
        request = APIRequestFactory().post(
            "/api/uploads/images",
            {"image": image},
            format="multipart",
        )
        force_authenticate(request, user=SimpleNamespace(is_authenticated=True))
        cloudinary_url = "https://res.cloudinary.com/example/image/upload/test.png"

        with patch("uploads.views.default_storage") as storage:
            storage.save.return_value = "uploads/test.png"
            storage.url.return_value = cloudinary_url
            response = UploadImageView.as_view()(request)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.data,
            {"url": cloudinary_url, "name": "original.png", "size": len(b"image data")},
        )
        storage.save.assert_called_once()
        self.assertTrue(storage.save.call_args.args[0].startswith("uploads/"))
        storage.url.assert_called_once_with("uploads/test.png")

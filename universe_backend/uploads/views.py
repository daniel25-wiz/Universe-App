import os
import uuid

from django.conf import settings
from django.core.files.storage import default_storage
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from core.exceptions import ApiError

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


class UploadImageView(APIView):
    parser_classes = [MultiPartParser]

    def post(self, request):
        file_obj = request.FILES.get("image") or request.FILES.get("file")
        if file_obj is None:
            raise ApiError("No image file was provided.", code="VALIDATION_ERROR", status_code=400)

        ext = os.path.splitext(file_obj.name)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise ApiError("Only JPG, PNG, WEBP or GIF images are allowed.", code="INVALID_FILE_TYPE", status_code=400)
        if file_obj.size > settings.MAX_UPLOAD_BYTES:
            raise ApiError("Image must be smaller than 5MB.", code="FILE_TOO_LARGE", status_code=400)

        filename = f"uploads/{uuid.uuid4().hex}{ext}"
        saved_name = default_storage.save(filename, file_obj)
        url = default_storage.url(saved_name)
        return Response({"url": url, "name": file_obj.name, "size": file_obj.size}, status=201)

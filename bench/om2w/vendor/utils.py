# encode_image copied from OSU-NLP-Group/Online-Mind2Web src/utils.py (MIT License, (c) 2025 OSU NLP).
import base64
import io


def encode_image(image):
    """Convert a PIL image to base64 string."""
    if image.mode == "RGBA":
        image = image.convert("RGB")
    buffered = io.BytesIO()
    image.save(buffered, format="JPEG")
    return base64.b64encode(buffered.getvalue()).decode("utf-8")

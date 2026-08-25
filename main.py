import json
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Red Clack Shutter Count API", version="1.0.0")

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "https://redclack.com,https://www.redclack.com",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key"],
)

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))


def require_api_key(x_api_key: str | None) -> None:
    expected = os.getenv("API_KEY")
    if expected and x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")


def first_value(metadata: dict, *names: str):
    wanted = {name.lower() for name in names}
    for key, value in metadata.items():
        short_key = key.split(":")[-1].lower()
        if short_key in wanted and value not in (None, ""):
            return value, key
    return None, None


def parse_shutter_count(metadata: dict):
    # Be deliberately conservative: never infer or estimate a shutter count.
    # Only return values from tags explicitly named as shutter-count fields.
    candidates = {
        "shuttercount",
        "shuttercount2",
        "mechanicalshuttercount",
        "shuttercountvalue",
    }

    for key, value in metadata.items():
        short_key = key.split(":")[-1].lower()
        if short_key not in candidates:
            continue

        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            count = int(value)
            if count >= 0:
                return count, key
        if isinstance(value, str):
            cleaned = value.replace(",", "").strip()
            if cleaned.isdigit():
                return int(cleaned), key

    return None, None


@app.get("/")
def root():
    return {
        "service": "Red Clack Shutter Count API",
        "status": "ok",
        "privacy": "Uploaded files are processed temporarily and deleted after analysis.",
    }


@app.get("/health")
def health():
    try:
        result = subprocess.run(
            ["exiftool", "-ver"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        return {"status": "ok", "exiftool": result.stdout.strip()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ExifTool unavailable: {exc}")


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
):
    require_api_key(x_api_key)

    original_name = file.filename or "upload"
    suffix = Path(original_name).suffix[:12]
    tmp_path = None

    try:
        total = 0
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="File is too large")
                tmp.write(chunk)

        result = subprocess.run(
            ["exiftool", "-j", "-G1", "-a", "-s", tmp_path],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=422,
                detail="ExifTool could not read metadata from this file.",
            )

        parsed = json.loads(result.stdout)
        if not parsed:
            raise HTTPException(status_code=422, detail="No metadata found")

        metadata = parsed[0]
        make, _ = first_value(metadata, "Make")
        model, _ = first_value(metadata, "Model", "CameraModelName")
        file_type, _ = first_value(metadata, "FileType")
        capture_date, _ = first_value(metadata, "DateTimeOriginal", "CreateDate")
        shutter_count, shutter_tag = parse_shutter_count(metadata)

        if shutter_count is None:
            return {
                "status": "not_available",
                "make": make,
                "model": model,
                "file_type": file_type,
                "capture_date": capture_date,
                "shutter_count": None,
                "source_tag": None,
                "message_fa": "تعداد شاتر این مدل از فایل آپلودشده قابل استخراج نیست. لطفاً فایل اصلی و ویرایش‌نشده دوربین را آپلود کنید.",
            }

        return {
            "status": "found",
            "make": make,
            "model": model,
            "file_type": file_type,
            "capture_date": capture_date,
            "shutter_count": shutter_count,
            "source_tag": shutter_tag,
            "message_fa": "تعداد شاتر از متادیتای فایل استخراج شد.",
        }

    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Metadata analysis timed out")
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Invalid ExifTool response")
    finally:
        await file.close()
        if tmp_path:
            try:
                os.remove(tmp_path)
            except FileNotFoundError:
                pass

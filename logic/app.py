import os
import uuid
import re
from flask import Flask, request, send_file, jsonify
from werkzeug.utils import secure_filename
from PIL import Image
import pytesseract
import cv2
import numpy as np
from gtts import gTTS
from io import BytesIO
from flask_cors import CORS

# Configure Tesseract path if needed
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

app = Flask(__name__)
CORS(app)

UPLOAD_DIR = "tmp_uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

def preprocess_image_cv(image_path):
    """Read image, convert to grayscale, denoise, threshold - returns PIL image object"""
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError("Could not read image")
    
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    if max(h, w) < 800:
        gray = cv2.resize(gray, (w * 2, h * 2), interpolation=cv2.INTER_LINEAR)
    
    gray = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
    th = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY, 11, 2)
    return Image.fromarray(th)

def enhance_text_for_tts(text):
    """Improve punctuation, line breaks, and symbols for natural TTS output"""
    # Normalize punctuation spacing
    text = text.replace(',', ',   ')
    text = text.replace('.', '.     ')
    text = text.replace(';', ';     ')
    text = text.replace(':', ':  ')
    text = text.replace('?', '?     ')
    text = text.replace('!', '!   ')
    text = re.sub(r'\.(?!\d)', '. ', text)

    text = re.sub(r'\n+', '. ', text)
    text = re.sub(r'\.\s*\.', '.', text)  # Remove double periods

    text = text.replace('•', 'Next point: ')
    # text = re.sub(r'•\s*', '. ', text)

    

    # Remove non-ASCII characters and normalize whitespace
    text = re.sub(r'[^\x00-\x7F]+', ' ', text)
    text = re.sub(r'\s+', ' ', text)

    return text.strip()

@app.route('/process', methods=['POST'])
def process():
    if 'image' not in request.files:
        return jsonify({"error": "No image part"}), 400
    file = request.files['image']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    ocr_lang = request.form.get('ocr_lang', 'eng')
    tts_lang = request.form.get('tts_lang', 'en')

    filename = secure_filename(file.filename)
    file_id = str(uuid.uuid4())
    saved_path = os.path.join(UPLOAD_DIR, f"{file_id}_{filename}")
    file.save(saved_path)

    try:
        pil_img = preprocess_image_cv(saved_path)

        try:
            text = pytesseract.image_to_string(pil_img, lang=ocr_lang)
        except Exception:
            text = pytesseract.image_to_string(pil_img)

        text = enhance_text_for_tts(text)

        if not text:
            return jsonify({"error": "No text detected in image"}), 400
        if len(text) > 10000:
            text = text[:10000]

        tts = gTTS(text=text, lang=tts_lang, slow=False)
        mp3_io = BytesIO()
        tts.write_to_fp(mp3_io)
        mp3_io.seek(0)

        return send_file(mp3_io, mimetype="audio/mpeg", as_attachment=False, download_name="speech.mp3")
    except Exception as exc:
        print("Processing error:", exc)
        return jsonify({"error": "Processing failed", "detail": str(exc)}), 500
    finally:
        try:
            os.remove(saved_path)
        except:
            pass

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

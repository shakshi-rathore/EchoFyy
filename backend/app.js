
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PY_SERVICE = process.env.LOGIC_URL || "http://127.0.0.1:5000/process";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for image uploads
const upload = multer({
  dest: path.join(__dirname, 'uploads/'),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB 
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files allowed'), false);
    }
    cb(null, true);
  }
});

// DB pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'echofy',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Token 
async function createAndStoreToken(userId) {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
  await pool.execute('UPDATE users SET token = ? WHERE id = ?', [token, userId]);
  return token;
}

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    // basic validation
    if (!username || !email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Provide username, email and password (min 6 chars).' });
    }
    // check existing
    const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (rows.length) return res.status(400).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, password_hash]
    );
    const userId = result.insertId;
    const token = await createAndStoreToken(userId);
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Provide email and password' });

    const [rows] = await pool.execute('SELECT id, password_hash FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = await createAndStoreToken(user.id);
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// verify JWT 
async function verifyToken(req, res, next) {
  try {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ error: 'No token' });
    const parts = auth.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Bad token format' });

    const token = parts[1];
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const [rows] = await pool.execute('SELECT token FROM users WHERE id = ?', [payload.id]);
    if (!rows.length) return res.status(401).json({ error: 'User not found' });
    if (!rows[0].token || rows[0].token !== token) return res.status(401).json({ error: 'Token expired or revoked' });

    req.user = { id: payload.id };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Auth error' });
  }
}

// Image Forwarding
app.post('/api/process-image', verifyToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  try {
    const form = new FormData();
    form.append('image', fs.createReadStream(req.file.path));
    // // forward desired language (OCR lang) or tts_lang
    // if (req.body.ocr_lang) form.append('ocr_lang', req.body.ocr_lang);
    // if (req.body.tts_lang) form.append('tts_lang', req.body.tts_lang);

    const response = await axios.post(PY_SERVICE, form, {
      headers: {
        ...form.getHeaders()
      },
      responseType: 'arraybuffer',
      timeout: 120000
    });

    // forward content-type from python
    const contentType = response.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.send(Buffer.from(response.data));
  } catch (err) {
    console.error('Error proxying to python:', err.message || err);
    if (err.response && err.response.data) {
      // attempt to forward JSON error from python service
      try {
        const text = Buffer.from(err.response.data).toString('utf8');
        const json = JSON.parse(text);
        return res.status(err.response.status || 500).json(json);
      } catch (_) {}
    }
    res.status(500).json({ error: 'Processing failed' });
  } finally {
    // clean uploaded image
    fs.unlink(req.file.path, () => {});
  }
});

app.listen(PORT, () => {
  console.log(`Express backend running on http://localhost:${PORT}`);
});

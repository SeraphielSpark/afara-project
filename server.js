require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. NEON DATABASE CONNECTION
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { require: true } // Required for Neon
});

pool.connect()
    .then(() => console.log('✅ Connected to Neon PostgreSQL'))
    .catch(err => console.error('❌ Database connection error', err.stack));

// ==========================================
// 2. FILE UPLOADS (MULTER)
// ==========================================
// In production, you might swap this memory/disk storage for AWS S3 or Cloudinary
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ==========================================
// 3. MIDDLEWARE & SECURITY
// ==========================================
app.use(helmet({ contentSecurityPolicy: false })); // Configured for simplicity with CDNs
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serves CSS, JS, and /uploads
app.set('view engine', 'ejs');

// Admin Session Setup
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// Admin Auth Protection Middleware
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin/login');
    }
};

// ==========================================
// 4. PUBLIC ROUTES (SSR with EJS)
// ==========================================

app.get('/', async (req, res) => {
    try {
        const { rows: books } = await pool.query('SELECT * FROM books LIMIT 4');
        res.render('pages/index', { title: 'Home', books });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/books', async (req, res) => {
    try {
        const { rows: books } = await pool.query('SELECT * FROM books ORDER BY created_at DESC');
        res.render('pages/books', { title: 'Bookstore', books });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/teachings', async (req, res) => {
    try {
        const { rows: teachings } = await pool.query("SELECT * FROM teachings WHERE status = 'published' ORDER BY created_at DESC");
        res.render('pages/teachings', { title: 'Teachings', teachings });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/subscribe', async (req, res) => {
    const { email } = req.body;
    try {
        await pool.query('INSERT INTO newsletter_subscribers (email) VALUES ($1) ON CONFLICT DO NOTHING', [email]);
        res.status(200).json({ message: 'Subscribed successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to subscribe' });
    }
});

// ==========================================
// 5. ADMIN AUTHENTICATION
// ==========================================

app.get('/admin/login', (req, res) => {
    res.render('pages/admin-login', { error: null });
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (username === process.env.ADMIN_USERNAME) {
        const match = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
        if (match) {
            req.session.isAdmin = true;
            return res.redirect('/admin');
        }
    }
    res.render('pages/admin-login', { error: 'Invalid credentials' });
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ==========================================
// 6. PROTECTED ADMIN ROUTES & APIs
// ==========================================

// Dashboard View
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const bookCount = await pool.query('SELECT COUNT(*) FROM books');
        const memberCount = await pool.query('SELECT COUNT(*) FROM newsletter_subscribers');
        const { rows: recentTeachings } = await pool.query('SELECT * FROM teachings ORDER BY created_at DESC LIMIT 5');
        
        res.render('pages/admin', { 
            stats: { books: bookCount.rows[0].count, members: memberCount.rows[0].count },
            teachings: recentTeachings
        });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// Book Management View
app.get('/admin/books', requireAdmin, async (req, res) => {
    try {
        const { rows: books } = await pool.query('SELECT * FROM books ORDER BY created_at DESC');
        res.render('pages/admin-books', { books });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

// Create Book API (Handles Text + Cover Image Upload)
app.post('/api/admin/books', requireAdmin, upload.single('coverImage'), async (req, res) => {
    try {
        const { title, author, price, pages, description, impact_pct, tag } = req.body;
        const cover_image_url = req.file ? `/uploads/${req.file.filename}` : null;

        const query = `
            INSERT INTO books (title, author, price, pages, description, impact_pct, tag, cover_image_url) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
        `;
        const values = [title, author, price, pages, description, impact_pct, tag, cover_image_url];
        
        const { rows } = await pool.query(query, values);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add book' });
    }
});

// Delete Book API
app.delete('/api/admin/books/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM books WHERE id = $1', [id]);
        res.status(200).json({ message: 'Book deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete book' });
    }
});

// Create Teaching API (Handles Text + Banner Image Upload)
app.post('/api/admin/teachings', requireAdmin, upload.single('coverImage'), async (req, res) => {
    try {
        const { title, category, read_time, body, author, status } = req.body;
        const cover_image_url = req.file ? `/uploads/${req.file.filename}` : null;

        const query = `
            INSERT INTO teachings (title, category, read_time, body, author, status, cover_image_url) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `;
        const values = [title, category, read_time, body, author, status, cover_image_url];
        
        const { rows } = await pool.query(query, values);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add teaching' });
    }
});

// ==========================================
// 7. START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Production server running on port ${PORT}`);
});
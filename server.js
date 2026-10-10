const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 5000;

// =====================================================
// 1. MIDDLEWARE AND CORS
// =====================================================

const allowedOrigins = [
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://regal-pavlova-823257.netlify.app" // <-- Live Netlify frontend URL[cite: 1, 7]
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || origin === "null" || allowedOrigins.includes(origin)) {
            console.log(`[CORS ALLOWED] Origin: ${origin || "Direct/No Origin"}`);
            return callback(null, true);
        }
        console.log(`[CORS BLOCKED] Unauthorized origin tried to access: ${origin}`);
        return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true
}));

app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// =====================================================
// 2. DATABASE CONNECTION
// =====================================================

const dbPath = path.join(__dirname, "database.db");
const db = new Database(dbPath);

db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

console.log(`[DATABASE CONNECTED] Path: ${dbPath}`);

// =====================================================
// 3. PERSISTENT SQLITE SESSION STORE
// =====================================================

const sessionDbPath = path.join(__dirname, "sessions.sqlite");
const sessionDb = new Database(sessionDbPath);

sessionDb.pragma("journal_mode = WAL");

sessionDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

class BetterSqliteSessionStore extends session.Store {
    constructor(database) {
        super();
        this.db = database;
    }

    get(sid, callback) {
        try {
            const row = this.db.prepare(`
                SELECT sess, expired FROM sessions WHERE sid = ?
            `).get(sid);

            if (!row) {
                console.log(`[SESSION MISS] SID: ${sid.substring(0, 8)}... not found.`);
                return callback(null, null);
            }

            if (row.expired <= Date.now()) {
                console.log(`[SESSION EXPIRED] SID: ${sid.substring(0, 8)}... expired. Deleting.`);
                this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
                return callback(null, null);
            }

            console.log(`[SESSION HIT] SID: ${sid.substring(0, 8)}... retrieved.`);
            return callback(null, JSON.parse(row.sess));
        } catch (error) {
            console.error("[SESSION GET ERROR]", error);
            return callback(error);
        }
    }

    set(sid, sess, callback) {
        try {
            const expires = sess.cookie && sess.cookie.expires
                ? new Date(sess.cookie.expires).getTime()
                : Date.now() + (sess.cookie?.originalMaxAge || 86400000);

            this.db.prepare(`
                INSERT INTO sessions (sid, sess, expired)
                VALUES (?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET
                    sess = excluded.sess,
                    expired = excluded.expired
            `).run(sid, JSON.stringify(sess), expires);

            console.log(`[SESSION SAVE] SID: ${sid.substring(0, 8)}... saved/updated successfully.`);
            this.db.prepare("DELETE FROM sessions WHERE expired <= ?").run(Date.now());

            if (callback) callback(null);
        } catch (error) {
            console.error("[SESSION SET ERROR]", error);
            if (callback) return callback(error);
            this.emit("disconnect", error);
        }
    }

    destroy(sid, callback) {
        try {
            this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
            console.log(`[SESSION DESTROY] SID: ${sid.substring(0, 8)}... deleted.`);
            if (callback) callback(null);
        } catch (error) {
            console.error("[SESSION DESTROY ERROR]", error);
            if (callback) callback(error);
        }
    }

    touch(sid, sess, callback) {
        try {
            const expires = sess.cookie && sess.cookie.expires
                ? new Date(sess.cookie.expires).getTime()
                : Date.now() + (sess.cookie?.originalMaxAge || 86400000);

            this.db.prepare(`
                UPDATE sessions SET expired = ? WHERE sid = ?
            `).run(expires, sid);

            console.log(`[SESSION TOUCH] SID: ${sid.substring(0, 8)}... expiration extended.`);
            if (callback) callback(null);
        } catch (error) {
            console.error("[SESSION TOUCH ERROR]", error);
            if (callback) callback(error);
        }
    }
}

const sessionStore = new BetterSqliteSessionStore(sessionDb);

app.use(session({
    name: "akcrafts.sid",
    secret: process.env.SESSION_SECRET || "akcrafts-local-development-secret-change-this",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        secure: true,   // Required for HTTPS cross-site requests (Netlify -> Render)[cite: 1, 7]
        sameSite: "none", // Required for cross-site cookies[cite: 1, 7]
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// Serve static assets
app.use(express.static(__dirname));

// =====================================================
// 4. CREATE DATABASE TABLES
// =====================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        image TEXT,
        description TEXT
    );

    CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT,
        fullname TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        delivery_date TEXT,
        payment_method TEXT,
        special_instructions TEXT,
        total_amount REAL DEFAULT 0,
        status TEXT DEFAULT 'Pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullname TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        member_since INTEGER DEFAULT 2026,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS wishlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, product_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );
`);

console.log("[DATABASE TABLES] Verified / Created successfully.");

// =====================================================
// 5. DATABASE MIGRATIONS
// =====================================================

function addColumnIfMissing(tableName, columnName, columnDefinition) {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();

    if (!columns.some(column => column.name === columnName)) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
        console.log(`[DATABASE MIGRATION] Added missing column -> ${tableName}.${columnName}`);
    }
}

addColumnIfMissing("users", "password", "TEXT");
addColumnIfMissing("users", "email", "TEXT");
addColumnIfMissing("users", "phone", "TEXT");
addColumnIfMissing("users", "address", "TEXT");
addColumnIfMissing("users", "member_since", "INTEGER DEFAULT 2026");
addColumnIfMissing("users", "created_at", "TEXT");

addColumnIfMissing("products", "image", "TEXT");
addColumnIfMissing("products", "description", "TEXT");

addColumnIfMissing("orders", "order_number", "TEXT");
addColumnIfMissing("orders", "phone", "TEXT");
addColumnIfMissing("orders", "address", "TEXT");
addColumnIfMissing("orders", "delivery_date", "TEXT");
addColumnIfMissing("orders", "payment_method", "TEXT");
addColumnIfMissing("orders", "special_instructions", "TEXT");
addColumnIfMissing("orders", "total_amount", "REAL DEFAULT 0");
addColumnIfMissing("orders", "status", "TEXT DEFAULT 'Pending'");
addColumnIfMissing("orders", "created_at", "TEXT");

// =====================================================
// 6. SEED PRODUCTS IF THE PRODUCTS TABLE IS EMPTY
// =====================================================

const productCount = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;

if (productCount === 0) {
    console.log("[SEEDING] Products table is empty. Inserting default flower products...");
    const insertProduct = db.prepare(`
        INSERT INTO products (name, price, image, description)
        VALUES (?, ?, ?, ?)
    `);

    const seedProducts = [
        ["Classic Red Roses", 150, "images/red-roses.jpg", "A classic arrangement of beautiful red roses."],
        ["Pink Rose Bouquet", 180, "images/pink-roses.jpg", "A lovely pink rose bouquet for special occasions."],
        ["Sunflower Bouquet", 200, "images/sunflowers.jpg", "Bright sunflowers that bring happiness."],
        ["White Tulip Bouquet", 220, "images/white-tulips.jpg", "Elegant white tulips for a simple, timeless gift."],
        ["Mixed Flower Bouquet", 250, "images/mixed-flowers.jpg", "A colorful mix of seasonal flowers."],
        ["Baby's Breath Bouquet", 160, "images/babys-breath.jpg", "A delicate arrangement of baby's breath flowers."],
        ["Pink Carnation Bouquet", 170, "images/pink-carnations.jpg", "Soft pink carnations for a thoughtful gift."],
        ["Premium Rose Bouquet", 300, "images/premium-roses.jpg", "A premium rose bouquet for memorable celebrations."]
    ];

    const insertProducts = db.transaction(products => {
        for (const product of products) {
            insertProduct.run(...product);
        }
    });

    insertProducts(seedProducts);
    console.log("[SEEDING COMPLETE] 8 flower products added.");
} else {
    console.log(`[PRODUCTS CHECK] Found ${productCount} existing products in database.`);
}

// =====================================================
// 7. SEED A DEFAULT PROFILE IF USERS TABLE IS EMPTY
// =====================================================

const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;

if (userCount === 0) {
    console.log("[SEEDING] Users table is empty. Creating default test user...");
    db.prepare(`
        INSERT INTO users (fullname, username, email, phone, address, member_since, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        "A&K Crafts Customer",
        "akcustomer",
        "customer@example.com",
        "",
        "",
        new Date().getFullYear(),
        new Date().toISOString()
    );

    console.log("[SEEDING COMPLETE] Default user profile created.");
} else {
    console.log(`[USERS CHECK] Found ${userCount} existing user record(s) in database.`);
}

// =====================================================
// 8. HELPER FUNCTIONS & COMPREHENSIVE ACTIVITY LOGGER
// =====================================================

function getAuthenticatedUser(req) {
    if (!req.session || !req.session.userId) return null;

    return db.prepare(`
        SELECT id, fullname, username, email, phone, address, member_since, created_at
        FROM users
        WHERE id = ?
    `).get(req.session.userId) || null;
}

function formatUser(user) {
    if (!user) return null;
    const createdAt = user.created_at || null;
    return {
        id: user.id,
        fullname: user.fullname,
        fullName: user.fullname,
        username: user.username,
        email: user.email,
        phone: user.phone || "",
        address: user.address || "",
        memberSince: createdAt,
        createdAt: createdAt,
        created_at: createdAt
    };
}

function getProfileStats(user) {
    const orderStats = db.prepare(`
        SELECT
            COUNT(*) AS totalOrders,
            SUM(CASE WHEN LOWER(COALESCE(status, 'pending')) = 'pending' THEN 1 ELSE 0 END) AS pendingOrders
        FROM orders
        WHERE LOWER(email) = LOWER(?)
    `).get(user.email);

    const wishlistStats = db.prepare(`
        SELECT COUNT(*) AS wishlistItems
        FROM wishlist
        WHERE user_id = ?
    `).get(user.id);

    return {
        totalOrders: orderStats.totalOrders || 0,
        pendingOrders: orderStats.pendingOrders || 0,
        wishlistItems: wishlistStats.wishlistItems || 0
    };
}

function requireLogin(req, res, next) {
    const user = getAuthenticatedUser(req);

    if (!user) {
        console.log(`[AUTH FAILED] Unauthorized access block on ${req.method} ${req.originalUrl}`);
        return res.status(401).json({
            success: false,
            message: "Please log in to continue."
        });
    }

    req.authenticatedUser = user;
    next();
}

// MAXIMUM ACTIVITY LOGGER MIDDLEWARE (Prints every request, query, body, and status)
app.use((req, res, next) => {
    const startedAt = Date.now();
    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

    console.log(`\n----------------------------------------`);
    console.log(`[INCOMING REQUEST] ${req.method} ${req.originalUrl}`);
    console.log(`[CLIENT IP] ${clientIp}`);
    
    if (Object.keys(req.query).length > 0) {
        console.log(`[QUERY PARAMS]`, JSON.stringify(req.query));
    }

    if (req.body && Object.keys(req.body).length > 0) {
        // Safe logging: hide password values for security
        const sanitizedBody = { ...req.body };
        if (sanitizedBody.password) sanitizedBody.password = "********";
        console.log(`[REQUEST BODY]`, JSON.stringify(sanitizedBody));
    }

    res.on("finish", () => {
        const duration = Date.now() - startedAt;
        console.log(`[RESPONSE SENT] Status: ${res.statusCode} | Time: ${duration}ms`);
        console.log(`----------------------------------------\n`);
    });

    next();
});

// =====================================================
// 9. API HOME
// =====================================================

app.get("/api", (req, res) => {
    console.log("[API ROUTE] Home index requested.");
    res.json({
        success: true,
        message: "A&K Crafts API is running.",
        endpoints: [
            "GET /api/products",
            "POST /api/contact",
            "POST /api/orders",
            "POST /api/register",
            "POST /api/login",
            "POST /api/logout",
            "GET /api/profile",
            "PUT /api/profile",
            "GET /api/wishlist",
            "GET /api/wishlist/count",
            "POST /api/wishlist",
            "DELETE /api/wishlist/:product_id"
        ]
    });
});

// =====================================================
// 10. GET PRODUCTS, SEARCH, AND PRICE FILTERS
// =====================================================

app.get("/api/products", (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const filter = String(req.query.filter || "").trim();

        console.log(`[PRODUCTS QUERY] Search: "${search}" | Filter: "${filter}"`);

        let sql = "SELECT * FROM products WHERE 1 = 1";
        const params = [];

        if (search) {
            sql += " AND (name LIKE ? OR description LIKE ?)";
            params.push(`%${search}%`, `%${search}%`);
        }

        if (filter === "under150") {
            sql += " AND price < 150";
        } else if (filter === "150to200") {
            sql += " AND price >= 150 AND price <= 200";
        } else if (filter === "over200") {
            sql += " AND price > 200";
        }

        sql += " ORDER BY id DESC";

        const products = db.prepare(sql).all(...params);
        console.log(`[PRODUCTS SUCCESS] Found and returning ${products.length} product(s).`);

        return res.json({
            success: true,
            count: products.length,
            products
        });
    } catch (error) {
        console.error("[PRODUCTS ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve products."
        });
    }
});

// =====================================================
// 11. REGISTER ACCOUNT
// =====================================================

app.post("/api/register", async (req, res) => {
    try {
        const fullname = String(req.body.fullname || "").trim();
        const username = String(req.body.username || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const phone = String(req.body.phone || "").trim();
        const address = String(req.body.address || "").trim();
        const password = String(req.body.password || "");

        console.log(`[REGISTER ATTEMPT] Username: ${username} | Email: ${email}`);

        if (!fullname || !username || !email || !phone || !address || !password) {
            console.log("[REGISTER BLOCKED] Missing required fields.");
            return res.status(400).json({
                success: false,
                message: "Please complete all registration fields."
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            console.log(`[REGISTER BLOCKED] Invalid email format: ${email}`);
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address."
            });
        }

        if (username.length < 3) {
            return res.status(400).json({
                success: false,
                message: "Username must contain at least 3 characters."
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must contain at least 8 characters."
            });
        }

        const existingUsername = db.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").get(username);
        if (existingUsername) {
            console.log(`[REGISTER CONFLICT] Username already taken: ${username}`);
            return res.status(409).json({
                success: false,
                message: "That username is already registered."
            });
        }

        const existingEmail = db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)").get(email);
        if (existingEmail) {
            console.log(`[REGISTER CONFLICT] Email already registered: ${email}`);
            return res.status(409).json({
                success: false,
                message: "That email address is already registered."
            });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const memberSince = new Date().getFullYear();
        const createdAt = new Date().toISOString();

        const result = db.prepare(`
            INSERT INTO users (fullname, username, email, phone, address, member_since, password, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(fullname, username, email, phone, address, memberSince, hashedPassword, createdAt);

        const newUserId = Number(result.lastInsertRowid);
        console.log(`[DATABASE INSERT] New user created successfully. User ID: ${newUserId}`);

        req.session.regenerate((sessionError) => {
            if (sessionError) {
                console.error("[REGISTER SESSION ERROR]", sessionError);
                return res.status(500).json({
                    success: false,
                    message: "Your account was created, but a login session could not be started. Please log in."
                });
            }

            req.session.userId = newUserId;

            req.session.save((saveError) => {
                if (saveError) {
                    console.error("[REGISTER SESSION SAVE ERROR]", saveError);
                    return res.status(500).json({
                        success: false,
                        message: "Your account was created, but your login session could not be saved. Please log in."
                    });
                }

                const currentUser = db.prepare(`
                    SELECT id, fullname, username, email, phone, address, member_since, created_at
                    FROM users WHERE id = ?
                `).get(newUserId);

                console.log(`[AUTH SUCCESS] Account registered & logged in automatically: ${username} (ID: ${newUserId})`);

                return res.status(201).json({
                    success: true,
                    loggedIn: true,
                    message: "Account created successfully.",
                    user: formatUser(currentUser)
                });
            });
        });
    } catch (error) {
        console.error("[REGISTER ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Registration failed. Please try again."
        });
    }
});

// =====================================================
// 12. LOGIN
// =====================================================

app.post("/api/login", async (req, res) => {
    try {
        const identifier = String(req.body.identifier || "").trim();
        const password = String(req.body.password || "");

        console.log(`[LOGIN ATTEMPT] Identifier: ${identifier}`);

        if (!identifier || !password) {
            console.log("[LOGIN BLOCKED] Missing identifier or password.");
            return res.status(400).json({
                success: false,
                message: "Please enter your username/email and password."
            });
        }

        const user = db.prepare(`
            SELECT * FROM users
            WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
            LIMIT 1
        `).get(identifier, identifier);

        if (!user || !user.password) {
            console.log(`[LOGIN FAILED] No matching user found for: ${identifier}`);
            return res.status(401).json({
                success: false,
                message: "Invalid username/email or password."
            });
        }

        const passwordMatches = await bcrypt.compare(password, user.password);

        if (!passwordMatches) {
            console.log(`[LOGIN FAILED] Password mismatch for user: ${user.username}`);
            return res.status(401).json({
                success: false,
                message: "Invalid username/email or password."
            });
        }

        req.session.regenerate((sessionError) => {
            if (sessionError) {
                console.error("[LOGIN SESSION ERROR]", sessionError);
                return res.status(500).json({
                    success: false,
                    message: "Unable to create a login session."
                });
            }

            req.session.userId = user.id;

            req.session.save((saveError) => {
                if (saveError) {
                    console.error("[LOGIN SESSION SAVE ERROR]", saveError);
                    return res.status(500).json({
                        success: false,
                        message: "Unable to save your login session."
                    });
                }

                const currentUser = db.prepare(`
                    SELECT id, fullname, username, email, phone, address, member_since, created_at
                    FROM users WHERE id = ?
                `).get(user.id);

                console.log(`[LOGIN SUCCESS] User authenticated: ${user.username} (ID: ${user.id}) | Session ID: ${req.session.id.substring(0, 8)}...`);

                return res.json({
                    success: true,
                    message: "Login successful.",
                    user: formatUser(currentUser),
                    stats: getProfileStats(currentUser)
                });
            });
        });
    } catch (error) {
        console.error("[LOGIN ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Login failed. Please try again."
        });
    }
});

// =====================================================
// 13. LOGOUT
// =====================================================

app.post("/api/logout", (req, res) => {
    const user = getAuthenticatedUser(req);
    const username = user ? user.username : "Unknown user";

    console.log(`[LOGOUT REQUEST] User: ${username}`);

    req.session.destroy((error) => {
        if (error) {
            console.error("[LOGOUT ERROR]", error);
            return res.status(500).json({
                success: false,
                message: "Unable to log out."
            });
        }

        res.clearCookie("akcrafts.sid", {
            httpOnly: true,
            secure: true,
            sameSite: "none"
        });

        console.log(`[LOGOUT SUCCESS] Session destroyed for: ${username}`);

        return res.json({
            success: true,
            message: "Logged out successfully."
        });
    });
});

// =====================================================
// 14. GET LOGGED-IN USER PROFILE
// =====================================================

app.get("/api/profile", (req, res) => {
    try {
        const user = getAuthenticatedUser(req);

        if (!user) {
            console.log("[PROFILE REQUEST DENIED] No active session found.");
            return res.status(401).json({
                success: false,
                message: "Please log in to view your profile."
            });
        }

        const stats = getProfileStats(user);
        console.log(`[PROFILE SUCCESS] Retrieved profile data for user: ${user.username}`);

        return res.json({
            success: true,
            user: formatUser(user),
            stats
        });
    } catch (error) {
        console.error("[PROFILE ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve profile."
        });
    }
});

// =====================================================
// 15. UPDATE LOGGED-IN USER PROFILE
// =====================================================

app.put("/api/profile", requireLogin, (req, res) => {
    try {
        const fullname = String(req.body.fullname || req.body.fullName || "").trim();
        const username = String(req.body.username || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const phone = String(req.body.phone || "").trim();
        const address = String(req.body.address || "").trim();

        console.log(`[PROFILE UPDATE] User ID ${req.authenticatedUser.id} trying to update details.`);

        if (!fullname || !username || !email) {
            return res.status(400).json({
                success: false,
                message: "Full name, username, and email are required."
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address."
            });
        }

        const duplicateUsername = db.prepare(`
            SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?
        `).get(username, req.authenticatedUser.id);

        if (duplicateUsername) {
            return res.status(409).json({
                success: false,
                message: "That username is already in use."
            });
        }

        const duplicateEmail = db.prepare(`
            SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?
        `).get(email, req.authenticatedUser.id);

        if (duplicateEmail) {
            return res.status(409).json({
                success: false,
                message: "That email address is already in use."
            });
        }

        db.prepare(`
            UPDATE users
            SET fullname = ?, username = ?, email = ?, phone = ?, address = ?
            WHERE id = ?
        `).run(fullname, username, email, phone, address, req.authenticatedUser.id);

        const updatedUser = db.prepare(`
            SELECT id, fullname, username, email, phone, address, member_since, created_at
            FROM users WHERE id = ?
        `).get(req.authenticatedUser.id);

        console.log(`[PROFILE UPDATE SUCCESS] User ID ${updatedUser.id} updated profile successfully.`);

        return res.json({
            success: true,
            message: "Profile updated successfully.",
            user: formatUser(updatedUser),
            stats: getProfileStats(updatedUser)
        });
    } catch (error) {
        console.error("[PROFILE UPDATE ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update profile."
        });
    }
});

// =====================================================
// 16. SUBMIT CONTACT MESSAGE
// =====================================================

app.post("/api/contact", (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const message = String(req.body.message || "").trim();

        console.log(`[CONTACT FORM] Received message from: ${name} (${email})`);

        if (!name || !email || !message) {
            return res.status(400).json({
                success: false,
                message: "Please complete all contact fields."
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address."
            });
        }

        const result = db.prepare(`
            INSERT INTO contacts (name, email, message) VALUES (?, ?, ?)
        `).run(name, email, message);

        console.log(`[CONTACT SAVED] Message ID: ${result.lastInsertRowid} stored in database.`);

        return res.status(201).json({
            success: true,
            message: "Your message has been sent successfully.",
            contactId: result.lastInsertRowid
        });
    } catch (error) {
        console.error("[CONTACT ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to submit your message."
        });
    }
});

// =====================================================
// 17. CREATE ORDER
// =====================================================

app.post("/api/orders", (req, res) => {
    try {
        const fullname = String(req.body.fullname || req.body.fullName || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const phone = String(req.body.phone || "").trim();
        const address = String(req.body.address || "").trim();
        const deliveryDate = String(req.body.delivery_date || "").trim();
        const paymentMethod = String(req.body.payment_method || "").trim();
        const specialInstructions = String(req.body.special_instructions || "").trim();
        const totalAmount = Number(req.body.total_amount ?? req.body.totalAmount ?? 0);

        console.log(`[ORDER SUBMISSION] Customer: ${fullname} (${email}) | Total Amount: ₱${totalAmount}`);

        if (!fullname || !email || !phone || !address) {
            return res.status(400).json({
                success: false,
                message: "Please complete the required order details."
            });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid email address."
            });
        }

        if (!Number.isFinite(totalAmount) || totalAmount < 0) {
            return res.status(400).json({
                success: false,
                message: "The order total is invalid."
            });
        }

        const orderNumber = `AK-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

        const result = db.prepare(`
            INSERT INTO orders (
                order_number, fullname, email, phone, address,
                delivery_date, payment_method, special_instructions,
                total_amount, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            orderNumber, fullname, email, phone, address,
            deliveryDate, paymentMethod, specialInstructions,
            totalAmount, "Pending"
        );

        console.log(`[ORDER CREATED] Order #${orderNumber} saved successfully (ID: ${result.lastInsertRowid}).`);

        return res.status(201).json({
            success: true,
            message: "Your order has been placed successfully.",
            order: {
                id: result.lastInsertRowid,
                order_number: orderNumber,
                fullname,
                email,
                total_amount: totalAmount,
                status: "Pending"
            }
        });
    } catch (error) {
        console.error("[ORDER ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to place your order."
        });
    }
});

// =====================================================
// 18. GET LOGGED-IN USER'S WISHLIST COUNT
// =====================================================

app.get("/api/wishlist/count", requireLogin, (req, res) => {
    try {
        const result = db.prepare(`
            SELECT COUNT(*) AS count FROM wishlist WHERE user_id = ?
        `).get(req.authenticatedUser.id);

        console.log(`[WISHLIST COUNT] User ${req.authenticatedUser.username} has ${result.count} item(s).`);

        return res.json({
            success: true,
            count: result.count,
            wishlistItems: result.count
        });
    } catch (error) {
        console.error("[WISHLIST COUNT ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve wishlist count."
        });
    }
});

// =====================================================
// 19. GET LOGGED-IN USER'S WISHLIST
// =====================================================

app.get("/api/wishlist", requireLogin, (req, res) => {
    try {
        const products = db.prepare(`
            SELECT p.*, w.created_at AS added_at
            FROM wishlist w
            INNER JOIN products p ON p.id = w.product_id
            WHERE w.user_id = ?
            ORDER BY w.id DESC
        `).all(req.authenticatedUser.id);

        console.log(`[WISHLIST FETCH] Retrieved ${products.length} item(s) for user ${req.authenticatedUser.username}`);

        return res.json({
            success: true,
            count: products.length,
            products,
            wishlist: products
        });
    } catch (error) {
        console.error("[WISHLIST ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retrieve wishlist."
        });
    }
});

// =====================================================
// 20. ADD PRODUCT TO LOGGED-IN USER'S WISHLIST
// =====================================================

app.post("/api/wishlist", requireLogin, (req, res) => {
    try {
        const productId = Number(req.body.product_id ?? req.body.productId ?? req.body.id);
        console.log(`[WISHLIST ADD] User ${req.authenticatedUser.username} requested product ID: ${productId}`);

        if (!Number.isInteger(productId) || productId <= 0) {
            return res.status(400).json({
                success: false,
                message: "A valid product ID is required."
            });
        }

        const product = db.prepare("SELECT id FROM products WHERE id = ?").get(productId);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: "Product not found."
            });
        }

        const existingItem = db.prepare(`
            SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?
        `).get(req.authenticatedUser.id, productId);

        if (existingItem) {
            console.log(`[WISHLIST INFO] Product ${productId} is already in wishlist for ${req.authenticatedUser.username}`);
            return res.json({
                success: true,
                message: "This product is already in your wishlist."
            });
        }

        db.prepare(`
            INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)
        `).run(req.authenticatedUser.id, productId);

        console.log(`[WISHLIST SUCCESS] Product ${productId} added for user ${req.authenticatedUser.username}`);

        return res.status(201).json({
            success: true,
            message: "Product added to your wishlist."
        });
    } catch (error) {
        console.error("[WISHLIST ADD ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to add product to wishlist."
        });
    }
});

// =====================================================
// 21. REMOVE PRODUCT FROM LOGGED-IN USER'S WISHLIST
// =====================================================

app.delete("/api/wishlist/:product_id", requireLogin, (req, res) => {
    try {
        const productId = Number(req.params.product_id);
        console.log(`[WISHLIST REMOVE] User ${req.authenticatedUser.username} removing product ID: ${productId}`);

        if (!Number.isInteger(productId) || productId <= 0) {
            return res.status(400).json({
                success: false,
                message: "A valid product ID is required."
            });
        }

        const result = db.prepare(`
            DELETE FROM wishlist WHERE user_id = ? AND product_id = ?
        `).run(req.authenticatedUser.id, productId);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: "Product was not found in your wishlist."
            });
        }

        console.log(`[WISHLIST REMOVE SUCCESS] Product ${productId} removed for user ${req.authenticatedUser.username}`);

        return res.json({
            success: true,
            message: "Product removed from your wishlist."
        });
    } catch (error) {
        console.error("[WISHLIST REMOVE ERROR]", error);
        return res.status(500).json({
            success: false,
            message: "Failed to remove product from wishlist."
        });
    }
});

// =====================================================
// 22. API 404 HANDLER
// =====================================================

app.use("/api", (req, res) => {
    console.log(`[API 404 WARNING] Endpoint not found: ${req.method} ${req.originalUrl}`);
    return res.status(404).json({
        success: false,
        message: "API endpoint not found."
    });
});

// =====================================================
// 23. SERVER ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
    console.error("[SERVER ERROR CAUGHT]", error.message);

    if (res.headersSent) return next(error);

    if (error.message === "Origin not allowed by CORS") {
        return res.status(403).json({
            success: false,
            message: "This website origin is not allowed by the server."
        });
    }

    return res.status(500).json({
        success: false,
        message: "An internal server error occurred."
    });
});

// =====================================================
// 24. START SERVER
// =====================================================

const server = app.listen(PORT, () => {
    console.log("");
    console.log("============================================");
    console.log("       A&K CRAFTS BACKEND SERVER");
    console.log("============================================");
    console.log(`[SERVER STATUS] Running and listening on port ${PORT}`);
    console.log(`[API BASE] http://localhost:${PORT}/api`);
    console.log(`[DATABASE FILE] ${dbPath}`);
    console.log(`[SESSION DB] ${sessionDbPath}`);
    console.log("[SERVER READY] All logging hooks active. Waiting for traffic...");
    console.log("============================================");
    console.log("");
});

server.on("error", (error) => {
    console.error("[SERVER STARTUP ERROR]", error.message);

    if (error.code === "EADDRINUSE") {
        console.error(`[SERVER ERROR] Port ${PORT} is already in use. Please terminate other running node instances.`);
    }
});

// =====================================================
// 25. GRACEFULLY SHUT DOWN THE SERVER
// =====================================================

let isShuttingDown = false;

function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("\n[SHUTDOWN INITIATED] Closing database connections and server...");

    server.close(() => {
        try {
            db.close();
            console.log("[DATABASE CLOSED] SQLite main connection safely shut down.");

            sessionDb.close();
            console.log("[SESSION DATABASE CLOSED] SQLite session store safely shut down.");

            process.exit(0);
        } catch (error) {
            console.error("[SHUTDOWN ERROR]", error);
            process.exit(1);
        }
    });

    setTimeout(() => {
        console.error("[FORCED SHUTDOWN] Timeout reached. Exiting immediately.");
        process.exit(1);
    }, 10000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
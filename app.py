"""app.py — The entry point of the Daywell habit-tracker backend.

Run it from this folder with:
    python app.py
then open http://127.0.0.1:5000 in your browser.

The API endpoints live in routes/auth.py and routes/habits.py; the
database models live in models.py; settings come from config.py (+ .env).
"""

import os

from flask import Flask, abort, jsonify, send_from_directory
from flask_cors import CORS

from config import Config
from models import db
from routes.auth import auth_bp
from routes.habits import habits_bp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# The only file types we are willing to serve as frontend files. Anything
# else (app.py, models.py, .env, habits.db, ...) is off limits.
FRONTEND_EXTENSIONS = {
    ".html", ".css", ".js", ".map", ".svg", ".png", ".jpg", ".jpeg",
    ".ico", ".webp", ".woff", ".woff2",
}


def create_app():
    """Build and configure a fresh Flask app (an "application factory")."""
    app = Flask(__name__)
    app.config.from_object(Config)

    # ---- Session cookie rules ------------------------------------------- #
    # HttpOnly     -> JavaScript is not allowed to read the cookie.
    # SameSite=Lax -> the cookie rides along with same-site requests
    #                 (and safe top-level navigations) — the standard
    #                 choice for simple cookie-based auth.
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    # ---- Extensions ------------------------------------------------------- #
    db.init_app(app)  # connect SQLAlchemy to this app

    # CORS lets a frontend served from a different local port (for example
    # Live Server on http://127.0.0.1:5500) call this API on :5000 without
    # the browser blocking it. supports_credentials=True allows the session
    # cookie to travel with those cross-origin requests.
    CORS(app, supports_credentials=True)

    # ---- API blueprints ----------------------------------------------------- #
    app.register_blueprint(auth_bp)    # /api/signup, /api/login, /api/logout
    app.register_blueprint(habits_bp)  # /api/habits...

    # ---- The frontend files ------------------------------------------------- #
    # The frontend calls relative URLs like "/api/habits", so it works best
    # opened on the same origin as this server. Serving index/signup/
    # dashboard plus the css/ and js/ folders from Flask makes that work
    # with zero configuration: just open http://127.0.0.1:5000.
    @app.route("/")
    def home():
        return send_from_directory(BASE_DIR, "index.html")

    @app.route("/<path:filename>")
    def frontend_file(filename):
        # Serve only real frontend files; hide everything else (secrets,
        # the database, the Python code) behind a plain 404.
        extension = os.path.splitext(filename)[1].lower()
        if filename.startswith(".") or extension not in FRONTEND_EXTENSIONS:
            abort(404)
        return send_from_directory(BASE_DIR, filename)

    # ---- Database ------------------------------------------------------------ #
    with app.app_context():
        # Creates habits.db and all tables on the first run; a no-op after
        # that if the tables already exist.
        db.create_all()

    # ---- Tiny health check --------------------------------------------------- #
    @app.get("/api/health")
    def health():
        """A no-auth endpoint you can hit to check the server is alive."""
        return jsonify({"status": "ok"})

    return app


# The module-level "app", so the file can also be imported: `from app import app`.
app = create_app()


if __name__ == "__main__":
    # debug=True -> auto-restarts on code changes and shows detailed error
    # pages. Great while learning, but never run with debug in production!
    app.run(debug=True, port=5000)

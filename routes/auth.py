"""routes/auth.py — Sign up, log in, log out.

How the sessions work here (no tokens, no JWT — just a cookie):

  1. On a successful signup / login we store the user's id in Flask's
     "session" object.
  2. Flask serialises that session into a signed, HttpOnly cookie and
     sends it back in the Set-Cookie response header.
  3. On every later request the browser attaches the cookie automatically
     (that's what fetch's "credentials" option is for), Flask checks the
     signature, and session["user_id"] is available again.

The frontend never reads or stores the cookie itself — the browser
handles it, and JavaScript can't even look inside it (HttpOnly).
"""

import re

from flask import Blueprint, jsonify, request, session
from sqlalchemy.exc import IntegrityError

from models import User, db

# All of this file's routes live on this "blueprint", which app.py
# registers on the main app.
auth_bp = Blueprint("auth", __name__)

# A light "does this look like an email?" check — not full RFC validation.
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def user_from_session():
    """Return the signed-in User row, or None if the session is empty/stale."""
    user_id = session.get("user_id")
    if not user_id:
        return None
    # db.session.get() fetches one row by primary key (None if missing).
    return db.session.get(User, user_id)


@auth_bp.post("/api/signup")
def signup():
    """Create a new account, then sign the user in right away."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Please send JSON with username, email and password."}), 400

    # .strip() removes accidental spaces around the values.
    username = str(data.get("username") or "").strip()
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")

    # ---- Input validation (400 = bad request) -------------------------- #
    if not username:
        return jsonify({"error": "Please tell us your name."}), 400
    if len(username) > 80:
        return jsonify({"error": "Your name must be 80 characters or fewer."}), 400
    if not EMAIL_PATTERN.match(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(email) > 120:
        return jsonify({"error": "Your email must be 120 characters or fewer."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if len(password) > 128:
        return jsonify({"error": "Password must be 128 characters or fewer."}), 400

    # ---- Duplicate email check ----------------------------------------- #
    if User.query.filter_by(email=email).first() is not None:
        # 409 Conflict is the textbook code for duplicates, but 400 keeps
        # things simple and the frontend just shows the message either way.
        return jsonify({"error": "An account with this email already exists."}), 400

    # ---- Create the user ------------------------------------------------ #
    user = User(username=username, email=email)
    user.set_password(password)  # stores the hash, never the raw password
    db.session.add(user)
    try:
        db.session.commit()
    except IntegrityError:
        # Two requests tried to claim the same email at the same moment;
        # the database's unique=True rule stopped the second one.
        db.session.rollback()
        return jsonify({"error": "An account with this email already exists."}), 400

    # ---- Sign the new user in ------------------------------------------- #
    session["user_id"] = user.id  # rides along inside the session cookie
    return jsonify({"message": "Account created.", "user": user.to_dict()}), 201


@auth_bp.post("/api/login")
def login():
    """Sign in with email + password.

    A POST with an empty body is a "session probe" (the frontend sends one
    when you land on the login page to ask: "am I still signed in?").
    If the cookie is still valid we answer 200 so it can skip the form.
    """
    data = request.get_json(silent=True)

    if not isinstance(data, dict) or not data:
        user = user_from_session()
        if user is not None:
            return jsonify({"message": "Already signed in.", "user": user.to_dict()})
        return jsonify({"error": "Please provide your email and password."}), 400

    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")

    if not email or not password:
        return jsonify({"error": "Please provide your email and password."}), 400

    user = User.query.filter_by(email=email).first()

    # One message for both "no such user" and "wrong password" so this
    # endpoint never reveals which emails have accounts.
    if user is None or not user.check_password(password):
        return jsonify({"error": "Invalid email or password."}), 401

    session["user_id"] = user.id
    return jsonify({"message": "Signed in.", "user": user.to_dict()})


@auth_bp.post("/api/logout")
def logout():
    """Log out: empty the session so the cookie no longer identifies anyone.

    Safe to call even when not signed in — it just clears an empty session.
    """
    session.clear()
    return jsonify({"message": "Signed out."})

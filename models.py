"""models.py — The database tables for the habit tracker.

Three tables:

  User    -> one account (username, email, hashed password, created_at)
  Habit   -> one habit that belongs to a user (name, optional category)
  CheckIn -> one "completed on this day" record for a habit

A unique constraint on (habit_id, date) makes it impossible to check in
twice on the same day — enforced by the database itself, not just code.
"""

from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import UniqueConstraint
from werkzeug.security import check_password_hash, generate_password_hash

# The single shared SQLAlchemy instance. app.py connects it to Flask with
# db.init_app(app); every model below inherits from db.Model.
db = SQLAlchemy()


def utc_now():
    """The current time in UTC — the default for created_at columns."""
    return datetime.now(timezone.utc)


class User(db.Model):
    """A Daywell account."""

    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), nullable=False)

    # unique=True -> the database itself refuses a second user with the
    # same email (routes/auth.py checks first so it can show a nice error).
    email = db.Column(db.String(120), unique=True, nullable=False)

    # We never store the raw password — only a salted hash of it.
    password_hash = db.Column(db.String(255), nullable=False)

    created_at = db.Column(db.DateTime, nullable=False, default=utc_now)

    # One user -> many habits. If a user row is ever deleted, their habits
    # (and those habits' check-ins) are deleted with it.
    habits = db.relationship(
        "Habit",
        backref="user",
        cascade="all, delete-orphan",
        lazy=True,
    )

    # ---- Password helpers --------------------------------------------- #

    def set_password(self, raw_password):
        """Hash a plain-text password and store only the hash."""
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        """True if the given plain-text password matches the stored hash."""
        return check_password_hash(self.password_hash, raw_password)

    # ---- JSON helper --------------------------------------------------- #

    def to_dict(self):
        """The public shape of a user. Never include the password hash!"""
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
        }


class Habit(db.Model):
    """One habit a user wants to keep up with."""

    __tablename__ = "habits"

    id = db.Column(db.Integer, primary_key=True)

    # Which user owns this habit (a foreign key into the users table).
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)

    name = db.Column(db.String(100), nullable=False)
    category = db.Column(db.String(40), nullable=True)  # optional
    created_at = db.Column(db.DateTime, nullable=False, default=utc_now)

    # Every check-in recorded for this habit, oldest first. Deleting the
    # habit deletes its check-ins too (cascade="all, delete-orphan").
    checkins = db.relationship(
        "CheckIn",
        backref="habit",
        cascade="all, delete-orphan",
        lazy=True,
        order_by="CheckIn.date",
    )

    def to_dict(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "name": self.name,
            "category": self.category or "",  # "" reads better than null
            "created_at": self.created_at.isoformat(),
        }


class CheckIn(db.Model):
    """One completed day for one habit."""

    __tablename__ = "checkins"

    __table_args__ = (
        # The rule that stops double check-ins: no two rows may share the
        # same habit AND the same day.
        UniqueConstraint("habit_id", "date", name="uq_checkin_habit_day"),
    )

    id = db.Column(db.Integer, primary_key=True)

    # Which habit this check-in belongs to (a foreign key into habits).
    habit_id = db.Column(db.Integer, db.ForeignKey("habits.id"), nullable=False)

    # Just a calendar day (no time part), e.g. 2026-09-15.
    date = db.Column(db.Date, nullable=False)

    # Kept as its own column so the API shape matches the frontend contract.
    completed = db.Column(db.Boolean, nullable=False, default=True)

    def to_dict(self):
        return {
            "id": self.id,
            "habit_id": self.habit_id,
            "date": self.date.isoformat(),  # "2026-09-15"
            "completed": self.completed,
        }

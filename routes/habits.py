"""routes/habits.py — Everything about habits and check-ins.

Endpoints (all require a signed-in session, checked with login_required):

  GET    /api/habits                -> list the signed-in user's habits
  POST   /api/habits                -> create a habit        {name, category}
  DELETE /api/habits/<id>           -> delete one of my habits
  POST   /api/habits/<id>/checkin   -> mark today as done
  GET    /api/habits/<id>/checkins  -> check-in history + streaks
"""

from datetime import date, datetime, timedelta
from functools import wraps

from flask import Blueprint, jsonify, request, session
from sqlalchemy.exc import IntegrityError

from models import CheckIn, Habit, User, db

habits_bp = Blueprint("habits", __name__)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def login_required(view):
    """Decorator: refuse the request with 401 unless a session cookie exists.

    Usage:
        @habits_bp.get("/api/habits")
        @login_required
        def list_habits(): ...
    """

    @wraps(view)  # keeps the original function's name and docstring intact
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"error": "You must be signed in to do that."}), 401
        return view(*args, **kwargs)

    return wrapper


def current_user():
    """The signed-in User row (or None if the session is empty/stale)."""
    user_id = session.get("user_id")
    if not user_id:
        return None
    return db.session.get(User, user_id)


def find_own_habit_or_none(habit_id):
    """Look up a habit by id, but only if it belongs to the signed-in user.

    Anything else (missing habit, someone else's habit, stale session)
    comes back as None, which the routes turn into a 404. That way the
    endpoint never leaks another user's habits.
    """
    user = current_user()
    if user is None:
        return None
    habit = db.session.get(Habit, habit_id)
    if habit is None or habit.user_id != user.id:
        return None
    return habit


# ---------------------------------------------------------------------------
# Streak calculation
# ---------------------------------------------------------------------------

def calculate_streaks(checkin_dates, today=None):
    """Calculate the current and longest streak from a list of check-in dates.

    Parameters
    ----------
    checkin_dates : list
        Days the habit was completed. Items may be datetime.date objects,
        datetime objects, or "YYYY-MM-DD" strings. The list does not need
        to be sorted and must not contain duplicates (the database's
        unique constraint on habit_id + date already guarantees that).
    today : datetime.date, optional
        The day the "current" streak counts up to. Defaults to the real
        today; passing a fixed date makes the function easy to reason
        about when you're reading or testing the code.

    Returns
    -------
    dict: {"current": <int>, "longest": <int>}

      current — consecutive check-in days ending today. If today itself
                has no check-in yet, the streak can still be alive by
                ending yesterday (so an un-checked morning doesn't wipe
                out a running streak the moment the day rolls over).
      longest — the best run of consecutive days anywhere in history.
    """

    def parse_day(value):
        """Turn one check-in value (date/datetime/string) into a date."""
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        return date.fromisoformat(str(value)[:10])  # "2026-09-15T..." -> date

    today = today or date.today()

    # Normalise into a de-duplicated set of dates, ignoring any future
    # dates so they can never inflate a streak.
    days = {parse_day(value) for value in checkin_dates}
    days = {day for day in days if day <= today}

    if not days:
        return {"current": 0, "longest": 0}

    # ---- Longest streak: walk the days in order and count runs. -------- #
    longest = 0
    run = 0
    previous = None
    for day in sorted(days):
        if previous is not None and (day - previous).days == 1:
            run += 1          # this day continues the current run
        else:
            run = 1           # a gap (or the first day) starts a new run
        longest = max(longest, run)
        previous = day

    # ---- Current streak: count backwards from today. -------------------- #
    cursor = today
    if cursor not in days:
        cursor -= timedelta(days=1)  # a streak "ending yesterday" still counts
    if cursor not in days:
        return {"current": 0, "longest": longest}

    current = 0
    while cursor in days:            # walk back day by day until a gap
        current += 1
        cursor -= timedelta(days=1)

    return {"current": current, "longest": longest}


# ---------------------------------------------------------------------------
# Habit endpoints
# ---------------------------------------------------------------------------

@habits_bp.get("/api/habits")
@login_required
def list_habits():
    """Return the signed-in user's habits as a JSON array."""
    user = current_user()
    if user is None:
        # The session pointed at a user that no longer exists.
        return jsonify({"error": "Session expired. Please sign in again."}), 401

    habits = (
        Habit.query
        .filter_by(user_id=user.id)
        .order_by(Habit.id.asc())  # creation order, so the list is stable
        .all()
    )
    return jsonify([habit.to_dict() for habit in habits])


@habits_bp.post("/api/habits")
@login_required
def create_habit():
    """Create a new habit for the signed-in user. Body: {name, category}."""
    user = current_user()
    if user is None:
        return jsonify({"error": "Session expired. Please sign in again."}), 401

    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    category = str(data.get("category") or "").strip()

    # ---- Validation (400 = bad request) --------------------------------- #
    if not name:
        return jsonify({"error": "Please give your habit a name."}), 400
    if len(name) > 100:
        return jsonify({"error": "Habit names must be 100 characters or fewer."}), 400
    if len(category) > 40:
        return jsonify({"error": "Categories must be 40 characters or fewer."}), 400

    # An empty category stays empty (the column is optional).
    habit = Habit(user_id=user.id, name=name, category=category or None)
    db.session.add(habit)
    db.session.commit()

    return jsonify(habit.to_dict()), 201


@habits_bp.delete("/api/habits/<int:habit_id>")
@login_required
def delete_habit(habit_id):
    """Delete a habit — but only if it belongs to the signed-in user."""
    habit = find_own_habit_or_none(habit_id)
    if habit is None:
        return jsonify({"error": "Habit not found."}), 404

    # The habit's check-ins are removed automatically (cascade in models.py).
    db.session.delete(habit)
    db.session.commit()

    return jsonify({"message": "Habit deleted.", "id": habit.id})


@habits_bp.post("/api/habits/<int:habit_id>/checkin")
@login_required
def checkin_habit(habit_id):
    """Mark today as completed for one habit (only once per day)."""
    habit = find_own_habit_or_none(habit_id)
    if habit is None:
        return jsonify({"error": "Habit not found."}), 404

    today = date.today()

    # First guard: is there already a check-in for today?
    already = CheckIn.query.filter_by(habit_id=habit.id, date=today).first()
    if already is not None:
        return jsonify({"error": "Already checked in today."}), 400

    checkin = CheckIn(habit_id=habit.id, date=today, completed=True)
    db.session.add(checkin)
    try:
        db.session.commit()
    except IntegrityError:
        # A second request snuck in between our check and our commit.
        # The (habit_id, date) unique constraint stopped it — roll back
        # and tell the user the same thing.
        db.session.rollback()
        return jsonify({"error": "Already checked in today."}), 400

    return jsonify({"message": "Checked in for today.", "date": today.isoformat()}), 201


@habits_bp.get("/api/habits/<int:habit_id>/checkins")
@login_required
def habit_checkins(habit_id):
    """Return a habit's check-in history plus its current/longest streaks."""
    habit = find_own_habit_or_none(habit_id)
    if habit is None:
        return jsonify({"error": "Habit not found."}), 404

    checkins = (
        CheckIn.query
        .filter_by(habit_id=habit.id)
        .order_by(CheckIn.date.asc())
        .all()
    )

    # calculate_streaks() is pure logic — feed it the dates, get the numbers.
    streaks = calculate_streaks([checkin.date for checkin in checkins])

    return jsonify({
        "habit_id": habit.id,
        "checkins": [checkin.to_dict() for checkin in checkins],
        "current_streak": streaks["current"],
        "longest_streak": streaks["longest"],
    })

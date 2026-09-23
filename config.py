"""config.py — Application configuration.

Settings like the secret key and the database location live in a ".env"
file next to this code (never hardcoded in the source). Copy the provided
".env.example" to ".env" and fill in real values.

python-dotenv reads that file and loads the variables into os.environ,
where the Config class below picks them up.
"""

import os

from dotenv import load_dotenv

# The folder this file lives in (the project root).
BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# Load the .env file into environment variables (existing environment
# variables always win, so you can override .env from the shell too).
load_dotenv(os.path.join(BASE_DIR, ".env"))


def _database_uri():
    """Decide which database to use (a SQLite file in this folder by default)."""
    url = os.environ.get("DATABASE_URL", "").strip()

    if not url:
        # Default: a habits.db file right here in the project folder.
        url = "sqlite:///" + os.path.join(BASE_DIR, "habits.db")

    elif url.startswith("sqlite:///"):
        # If .env lists a relative SQLite path (like "sqlite:///habits.db"),
        # anchor it to the project folder so the file is easy to find.
        path = url[len("sqlite:///"):]
        if path and not os.path.isabs(path):
            url = "sqlite:///" + os.path.join(BASE_DIR, path)

    return url


class Config:
    """Every setting Flask (and its extensions) needs, in one class."""

    # Used to sign the session cookie so users can't forge it.
    SECRET_KEY = os.environ.get("SECRET_KEY")

    # Where the database lives (SQLite for now — see _database_uri above).
    SQLALCHEMY_DATABASE_URI = _database_uri()

    # Turns off an event system we don't use; silences a loud warning.
    SQLALCHEMY_TRACK_MODIFICATIONS = False


# Fail fast (with a helpful message) if the secret key was never set.
if not Config.SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY is not set. Copy .env.example to a file named .env "
        "in this folder and add a line like:  SECRET_KEY=your-long-random-string"
    )

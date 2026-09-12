from app.config import Settings


def test_render_postgres_url_uses_psycopg3_driver():
    settings = Settings(database_url="postgresql://alpha:secret@db.example/alpha_trader")

    assert settings.database_url == "postgresql+psycopg://alpha:secret@db.example/alpha_trader"


def test_explicit_database_driver_is_preserved():
    settings = Settings(database_url="postgresql+psycopg://alpha:secret@db.example/alpha_trader")

    assert settings.database_url == "postgresql+psycopg://alpha:secret@db.example/alpha_trader"

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.capital_settings import read_capital_settings, write_capital_settings
from app.database import Base
from app.schemas import CapitalSettingsUpdate


def test_capital_settings_are_persisted(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'capital.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.capital_settings.SessionLocal", testing_session)

    assert read_capital_settings().total_amount == 10_000

    saved = write_capital_settings(CapitalSettingsUpdate(total_amount=25_800))
    reloaded = read_capital_settings()

    assert saved.total_amount == 25_800
    assert reloaded.total_amount == 25_800
    assert reloaded.currency == "USDT"

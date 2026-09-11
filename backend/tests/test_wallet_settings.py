from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import wallet_settings
from app.database import Base
from app.schemas import WalletSettingsUpdate


def test_wallet_address_is_persisted_and_normalized(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'wallet.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(wallet_settings, "SessionLocal", testing_session)
    address = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"

    saved = wallet_settings.write_wallet_settings(WalletSettingsUpdate(address=address))
    reloaded = wallet_settings.read_wallet_settings()

    assert reloaded is not None
    assert saved.address == address.lower()
    assert reloaded.address == address.lower()

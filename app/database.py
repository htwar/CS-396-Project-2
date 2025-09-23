from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = "postgresql+asyncpg://postgres:postgres@db:5432/postgres"

engine = create_async_engine(DATABASE_URL, echo=False)
SessionLocal = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)
Base = declarative_base()

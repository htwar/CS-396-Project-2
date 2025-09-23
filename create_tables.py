import asyncio
from app.database import engine, Base


async def create_tables():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("Tables created successfully!")


asyncio.run(create_tables())

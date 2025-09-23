from sqlalchemy import Column, Integer, String, Boolean, TIMESTAMP
from database import Base


class FileModel(Base):
    __tablename__ = "files"

    id = Column(Integer, primary_key=True, index=True)
    file_id = Column(String(64), unique=True, nullable=False)
    path = Column(String(1024), nullable=False)
    current_version = Column(Integer, nullable=False, default=1)
    created_by = Column(String(128))
    created_at = Column(TIMESTAMP(timezone=True), server_default="now()")
    deleted = Column(Boolean, default=False)


class FileVersionModel(Base):
    __tablename__ = "file_versions"

    id = Column(Integer, primary_key=True, index=True)
    file_id = Column(String(64), nullable=False)
    version = Column(Integer, nullable=False)
    object_key = Column(String(1024), nullable=False)
    checksum = Column(String(128))
    size = Column(Integer)
    created_at = Column(TIMESTAMP(timezone=True), server_default="now()")

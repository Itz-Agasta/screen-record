"""
app/schemas.py
==============
All Pydantic request/response models for the REST API.

Kept in a single file at this project scale — avoids circular imports
that arise when schemas reference each other across multiple files.
"""

from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, EmailStr, Field, field_validator


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1)

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str          # "admin" | "user"
    user_id: int


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

class AdminCreate(BaseModel):
    username: str   = Field(..., min_length=3, max_length=64)
    email:    EmailStr
    password: str   = Field(..., min_length=8)

class AdminOut(BaseModel):
    id:         int
    username:   str
    email:      str
    is_active:  bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# User — create / update / read
# ---------------------------------------------------------------------------

class UserCreate(BaseModel):
    username:           str = Field(..., min_length=3, max_length=64)
    email:              EmailStr
    password:           str = Field(..., min_length=8)
    permitted_sessions: int = Field(0, ge=0)

class UserUpdate(BaseModel):
    """All fields optional — PATCH semantics."""
    email:              Optional[EmailStr]  = None
    password:           Optional[str]       = Field(None, min_length=8)
    permitted_sessions: Optional[int]       = Field(None, ge=0)
    resume_text:        Optional[str]       = None
    job_description:    Optional[str]       = None
    custom_prompt:      Optional[str]       = None
    is_active:          Optional[bool]      = None

class UserOut(BaseModel):
    id:                 int
    username:           str
    email:              str
    permitted_sessions: int
    used_sessions:      int
    sessions_remaining: int      # computed property on the ORM model
    resume_text:        Optional[str]
    job_description:    Optional[str]
    custom_prompt:      Optional[str]
    is_active:          bool
    created_at:         datetime
    updated_at:         datetime

    model_config = {"from_attributes": True}

class UserSessionStatus(BaseModel):
    """Lightweight response for the .exe session-status check."""
    user_id:            int
    permitted_sessions: int
    used_sessions:      int
    sessions_remaining: int
    has_sessions_available: bool


class SessionStartResponse(BaseModel):
    allowed: bool
    active_slot: Optional[int] = None
    reason: Optional[str] = None


class SessionRespondRequest(BaseModel):
    utterance: str = Field(..., min_length=1)
    history: List[str] = Field(default_factory=list)
    speaker: Optional[str] = None
    pitch_rise: Optional[float] = Field(None, ge=0.0, le=1.0)
    pause_after_ms: Optional[int] = Field(None, ge=0, le=5000)


class SessionRespondResponse(BaseModel):
    should_respond: bool
    answer: Optional[str] = None
    reason: Optional[str] = None


class SessionTranscribeRequest(BaseModel):
    audio_base64: str
    audio_mime_type: Optional[str] = None


class SessionTranscribeResponse(BaseModel):
    transcript: List[str] = Field(default_factory=list)


class SessionEndRequest(BaseModel):
    transcript: List[str] = Field(default_factory=list)
    audio_base64: Optional[str] = None
    audio_mime_type: Optional[str] = None


class SessionEndResponse(BaseModel):
    summary: str


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

class SessionOut(BaseModel):
    id:                     int
    user_id:                int
    status:                 str
    transcript_text:        Optional[str]
    summary_text:           Optional[str]
    video_file_url:         Optional[str]
    video_file_size_bytes:  Optional[int]
    duration_seconds:       Optional[int]
    created_at:             datetime
    updated_at:             datetime

    model_config = {"from_attributes": True}

class SessionListItem(BaseModel):
    """Slim version for list views — omits raw transcript."""
    id:                    int
    user_id:               int
    status:                str
    summary_text:          Optional[str]
    video_file_url:        Optional[str]
    video_file_size_bytes: Optional[int]
    duration_seconds:      Optional[int]
    created_at:            datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

class UploadResponse(BaseModel):
    session_id:   int
    video_url:    str
    file_size_mb: float
    message:      str

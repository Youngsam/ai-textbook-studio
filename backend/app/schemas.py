from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ReaderState(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    page: int = Field(ge=1)
    zoom: float = Field(default=1, ge=0.5, le=3)
    scroll_offset: float = Field(default=0, ge=0, le=1)


Provider = Literal["openai", "claude", "gemini", "openrouter", "fake"]


class ModelSelection(BaseModel):
    provider: Provider
    model: str = Field(min_length=1, max_length=200, pattern=r"^\S+(?:[^\r\n]*\S)?$", strict=True)


class Preferences(BaseModel):
    provider: Provider | None = None
    response_style: Literal["step_by_step", "concise"] = "step_by_step"
    image_mode: Literal["auto", "always", "never"] = "auto"
    model: str | None = Field(default=None, max_length=200)

    @field_validator("model")
    @classmethod
    def clean_model(cls, value):
        if value is not None and ("\n" in value or "\r" in value):
            raise ValueError("모델명은 한 줄로 입력해 주세요.")
        return value.strip() if value is not None else None


class Question(Preferences):
    request_id: UUID
    question: str = Field(min_length=1, max_length=8000)
    page: int = Field(ge=1)
    selected_text: str = Field(default="", max_length=12000)

    @field_validator("question")
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError("질문을 입력해 주세요.")
        return value.strip()

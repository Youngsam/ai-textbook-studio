from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
    ):
        def environment():
            values = env_settings()
            # An IDE/agent may inject a different API key into the process environment.
            # An explicitly present project key (including a blank value) wins.
            if "openai_api_key" in dotenv_settings():
                values.pop("openai_api_key", None)
            return values

        return init_settings, environment, dotenv_settings, file_secret_settings

    data_dir: Path = ROOT / "data"
    database_url: str = ""
    openai_api_key: str = Field(default="", repr=False)
    llm_provider: Literal["openai", "fake"] = "openai"
    llm_model: str = Field(default="", validation_alias=AliasChoices("LLM_MODEL", "OPENAI_MODEL"))
    llm_allowed_models: str = "gpt-5.4-mini,gpt-5.4"
    llm_supports_images: bool = True
    llm_timeout_seconds: float = 120
    llm_input_token_budget: int = 12000
    llm_max_output_tokens: int = 2000
    max_upload_bytes: int = 100 * 1024 * 1024
    max_pdf_pages: int = 2000
    pdf_process_timeout_seconds: float = 30
    allowed_hosts: str = "localhost,127.0.0.1,[::1],testserver"
    allowed_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8000,http://localhost:8000"
    )

    def model_post_init(self, _context):
        self.data_dir = (ROOT / self.data_dir).resolve()
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'learning.db'}"
        elif self.database_url.startswith("sqlite:///./"):
            self.database_url = "sqlite:///" + str(
                ROOT / self.database_url.removeprefix("sqlite:///./")
            )
        if not self.database_url.startswith("sqlite:///"):
            raise ValueError("MVP supports local SQLite only")

    @property
    def available_models(self):
        return list(
            dict.fromkeys(
                model.strip()
                for model in [self.llm_model, *self.llm_allowed_models.split(",")]
                if model.strip()
            )
        )

    @property
    def llm_configured(self):
        return self.llm_provider == "fake" or bool(self.openai_api_key and self.llm_model)

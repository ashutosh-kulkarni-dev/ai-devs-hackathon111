"""
Thin Groq client shared by all agents.

Enforces structured, schema-validated output (Pydantic) rather than free-text
parsing -- this is what turns the PRD's CRISPE prompt appendix (docs/prompts/)
from documentation into something actually guaranteed at runtime.

DEMO_MODE / missing GROQ_API_KEY: falls back to deterministic mock
responses so the full multi-agent pipeline still runs end-to-end without
live credentials. Every mock response is generated from the same schema
used for the real path, so swapping in a real key changes nothing else.
"""
import json
import os
import random
from typing import Type, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

DEMO_MODE = os.environ.get("DEMO_MODE", "true").lower() == "true" or not os.environ.get("GROQ_API_KEY")


class LLMClient:
    def __init__(self, model: str = "openai/gpt-oss-20b"):
        self.model_name = model
        self._client = None
        if not DEMO_MODE:
            from groq import Groq
            self._client = Groq(api_key=os.environ["GROQ_API_KEY"])

    def generate_structured(self, system_prompt: str, user_prompt: str,
                             output_schema: Type[T], mock_factory=None) -> tuple[T, dict]:
        """Returns (parsed_output, token_usage). In DEMO_MODE, `mock_factory`
        (a zero-arg callable returning a dict matching output_schema) is used
        instead of calling Groq.
        """
        if DEMO_MODE:
            if mock_factory is None:
                raise ValueError("mock_factory required in DEMO_MODE")
            data = mock_factory()
            token_usage = {
                "prompt_tokens": len(user_prompt.split()),
                "completion_tokens": random.randint(80, 200),
            }
            return output_schema(**data), token_usage

        system_with_json = (
            f"{system_prompt}\n\nRespond with ONLY a single valid JSON object. "
            "No markdown, no code fences, no commentary."
        )
        response = self._client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": "system", "content": system_with_json},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        text = (response.choices[0].message.content or "").strip()
        if text.startswith("```"):
            text = text.lstrip("`").lstrip("json").strip().rstrip("`").strip()
        data = json.loads(text)
        usage = response.usage
        token_usage = {
            "prompt_tokens": usage.prompt_tokens if usage else 0,
            "completion_tokens": usage.completion_tokens if usage else 0,
        }
        return output_schema(**data), token_usage

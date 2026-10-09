"""Typed, versioned Options Surface serving configuration.

A configuration change is recorded on every snapshot. Historical replay
must use the recorded marker, not the current process flag.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import json
import os
from typing import Any, Mapping


CONFIG_VERSION = "surface_serving.v1"


class ServingMode(str, Enum):
    DIAGNOSTIC_CANDIDATE = "diagnostic_candidate"
    SHADOW_COMPARE = "shadow_compare"
    DISABLED = "disabled"


class PublishPolicy(str, Enum):
    """Whether an eligible constrained-SVI selection is published."""

    SERVE = "serve"
    RECORD_ONLY = "record_only"


class DisabledBaseline(str, Enum):
    """Explicit non-serving baseline when constrained SVI is disabled."""

    REJECTED = "rejected"
    UNAVAILABLE = "unavailable"


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    if value is None or not str(value).strip():
        return default
    return str(value).strip()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class SurfaceServingConfig:
    """Local, transparent serving-mode contract.

    This is not a remote feature-flag service. Defaults preserve the
    current diagnostic-candidate policy and never restore PCHIP serving.
    """

    version: str = CONFIG_VERSION
    mode: ServingMode = ServingMode.DIAGNOSTIC_CANDIDATE
    publish_policy: PublishPolicy = PublishPolicy.SERVE
    disabled_baseline: DisabledBaseline = DisabledBaseline.REJECTED
    require_iv_market: bool = True
    require_open_state: bool = True
    require_sizes: bool = True
    max_quote_age_seconds: float = 30.0

    @property
    def config_hash(self) -> str:
        payload = json.dumps(
            {
                "version": self.version,
                "mode": self.mode.value,
                "publish_policy": self.publish_policy.value,
                "disabled_baseline": self.disabled_baseline.value,
                "require_iv_market": self.require_iv_market,
                "require_open_state": self.require_open_state,
                "require_sizes": self.require_sizes,
                "max_quote_age_seconds": self.max_quote_age_seconds,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    @property
    def attempt_constrained_svi(self) -> bool:
        return self.mode is not ServingMode.DISABLED

    @property
    def publish_selected(self) -> bool:
        if self.mode is ServingMode.DISABLED:
            return False
        if self.mode is ServingMode.SHADOW_COMPARE:
            return self.publish_policy is PublishPolicy.SERVE
        return True

    def to_public_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "mode": self.mode.value,
            "publish_policy": self.publish_policy.value,
            "disabled_baseline": self.disabled_baseline.value,
            "require_iv_market": self.require_iv_market,
            "require_open_state": self.require_open_state,
            "require_sizes": self.require_sizes,
            "max_quote_age_seconds": self.max_quote_age_seconds,
            "config_hash": self.config_hash,
        }


def load_serving_config(
    mapping: Mapping[str, Any] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> SurfaceServingConfig:
    """Load config from an explicit mapping, else process environment."""
    if mapping is not None:
        return serving_config_from_mapping(mapping)
    env = environ if environ is not None else os.environ
    mode = _parse_mode(_env_from(env, "LOTUS_SURFACE_SERVING_MODE", ServingMode.DIAGNOSTIC_CANDIDATE.value))
    publish = _parse_publish(
        _env_from(env, "LOTUS_SURFACE_PUBLISH_POLICY", PublishPolicy.SERVE.value)
    )
    baseline = _parse_baseline(
        _env_from(env, "LOTUS_SURFACE_DISABLED_BASELINE", DisabledBaseline.REJECTED.value)
    )
    return SurfaceServingConfig(
        version=CONFIG_VERSION,
        mode=mode,
        publish_policy=publish,
        disabled_baseline=baseline,
    )


def serving_config_from_mapping(mapping: Mapping[str, Any]) -> SurfaceServingConfig:
    return SurfaceServingConfig(
        version=str(mapping.get("version") or mapping.get("config_version") or CONFIG_VERSION),
        mode=_parse_mode(mapping.get("mode") or mapping.get("serving_mode")),
        publish_policy=_parse_publish(mapping.get("publish_policy")),
        disabled_baseline=_parse_baseline(mapping.get("disabled_baseline")),
        require_iv_market=_as_bool(mapping.get("require_iv_market"), True),
        require_open_state=_as_bool(mapping.get("require_open_state"), True),
        require_sizes=_as_bool(mapping.get("require_sizes"), True),
        max_quote_age_seconds=float(mapping.get("max_quote_age_seconds") or 30.0),
    )


def quote_policy_for_source(source: str | None) -> dict[str, object]:
    """Match the live API: WS tickers require IV/state/size; REST book-summary does not.

    This is not a residual-budget or serving-gate change.
    """
    websocket = str(source or "").startswith("deribit_ticker_ws")
    return {
        "require_iv_market": websocket,
        "require_open_state": websocket,
        "require_sizes": websocket,
    }


def _as_bool(value: Any, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def default_serving_config() -> SurfaceServingConfig:
    return SurfaceServingConfig()


def _env_from(env: Mapping[str, str], name: str, default: str) -> str:
    value = env.get(name)
    if value is None or not str(value).strip():
        return default
    return str(value).strip()


def _parse_mode(value: Any) -> ServingMode:
    text = str(value or ServingMode.DIAGNOSTIC_CANDIDATE.value).strip().lower()
    for item in ServingMode:
        if item.value == text:
            return item
    raise ValueError(
        f"Unknown LOTUS_SURFACE_SERVING_MODE '{value}'. "
        "Expected diagnostic_candidate, shadow_compare, or disabled."
    )


def _parse_publish(value: Any) -> PublishPolicy:
    if value is None or value == "":
        return PublishPolicy.SERVE
    text = str(value).strip().lower()
    if text in {"serve", "publish", "true", "1"}:
        return PublishPolicy.SERVE
    if text in {"record_only", "withhold", "false", "0"}:
        return PublishPolicy.RECORD_ONLY
    raise ValueError(
        f"Unknown LOTUS_SURFACE_PUBLISH_POLICY '{value}'. "
        "Expected serve or record_only."
    )


def _parse_baseline(value: Any) -> DisabledBaseline:
    if value is None or value == "":
        return DisabledBaseline.REJECTED
    text = str(value).strip().lower()
    for item in DisabledBaseline:
        if item.value == text:
            return item
    raise ValueError(
        f"Unknown LOTUS_SURFACE_DISABLED_BASELINE '{value}'. "
        "Expected rejected or unavailable. PCHIP serving is not a baseline."
    )


# Convenience: collection defaults live beside serving config so one
# env section documents both. They do not change serving gates.
DEFAULT_CAPTURE_DIR = "project/runtime/options_surface_snapshots"
DEFAULT_RETENTION_DAYS = 180
DEFAULT_COLLECT_INTERVAL_SECONDS = 3600
DEFAULT_MAX_CURATED_EXPIRIES = 4
DEFAULT_EXPIRY_PAUSE_SECONDS = 1.0
DEFAULT_MAX_RETRIES = 2


def capture_directory(environ: Mapping[str, str] | None = None) -> str:
    env = environ if environ is not None else os.environ
    return _env_from(env, "LOTUS_SURFACE_CAPTURE_DIR", DEFAULT_CAPTURE_DIR)


def collect_enabled(environ: Mapping[str, str] | None = None) -> bool:
    env = environ if environ is not None else os.environ
    return _env_bool_from(env, "LOTUS_SURFACE_COLLECT_ENABLED", False)


def collect_interval_seconds(environ: Mapping[str, str] | None = None) -> int:
    env = environ if environ is not None else os.environ
    raw = _env_from(env, "LOTUS_SURFACE_COLLECT_INTERVAL_SECONDS", str(DEFAULT_COLLECT_INTERVAL_SECONDS))
    value = int(float(raw))
    if value < 60:
        raise ValueError("LOTUS_SURFACE_COLLECT_INTERVAL_SECONDS must be at least 60.")
    return value


def max_curated_expiries(environ: Mapping[str, str] | None = None) -> int:
    env = environ if environ is not None else os.environ
    raw = _env_from(env, "LOTUS_SURFACE_MAX_CURATED_EXPIRIES", str(DEFAULT_MAX_CURATED_EXPIRIES))
    value = int(raw)
    if value < 1:
        raise ValueError("LOTUS_SURFACE_MAX_CURATED_EXPIRIES must be at least 1.")
    return value


def capture_retention_days(environ: Mapping[str, str] | None = None) -> int:
    env = environ if environ is not None else os.environ
    raw = _env_from(env, "LOTUS_SURFACE_CAPTURE_RETENTION_DAYS", str(DEFAULT_RETENTION_DAYS))
    value = int(raw)
    if value < 1:
        raise ValueError("LOTUS_SURFACE_CAPTURE_RETENTION_DAYS must be at least 1.")
    return value


def _env_bool_from(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}

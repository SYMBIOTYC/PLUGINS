import copy
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker, ValidationError


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "contracts" / "plugin-event-v1.schema.json"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "plugin-event-valid.json"


class PluginEventSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.valid_event = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(cls.schema)
        cls.validator = Draft202012Validator(
            cls.schema,
            format_checker=FormatChecker(),
        )

    def assert_event_rejected(self, mutate):
        event = copy.deepcopy(self.valid_event)
        mutate(event)
        with self.assertRaises(ValidationError):
            self.validator.validate(event)

    def test_accepts_valid_private_artifact_reference(self):
        self.validator.validate(self.valid_event)

    def test_rejects_unknown_top_level_secret_property(self):
        self.assert_event_rejected(
            lambda event: event.update({"session_token": "must-not-be-here"})
        )

    def test_rejects_download_url_instead_of_opaque_artifact_reference(self):
        self.assert_event_rejected(
            lambda event: event["artifact_refs"][0].update(
                {"ref": "https://example.invalid/private.zip"}
            )
        )

    def test_rejects_invalid_sha256_digest(self):
        self.assert_event_rejected(
            lambda event: event["artifact_refs"][0].update({"sha256": "not-a-digest"})
        )

    def test_rejects_unknown_actor_type(self):
        self.assert_event_rejected(
            lambda event: event["actor"].update({"type": "anonymous"})
        )

    def test_rejects_non_immutable_source_commit(self):
        self.assert_event_rejected(
            lambda event: event.update({"source_commit": "main"})
        )

    def test_rejects_duplicate_requested_capabilities(self):
        self.assert_event_rejected(
            lambda event: event.update(
                {"requested_capabilities": ["plugin.validate", "plugin.validate"]}
            )
        )

    def test_rejects_invalid_timestamp(self):
        self.assert_event_rejected(
            lambda event: event.update({"issued_at": "not-a-timestamp"})
        )


if __name__ == "__main__":
    unittest.main()

import json
import pathlib
import unittest

from fingerprint import fingerprint

EXT = pathlib.Path(__file__).resolve().parents[2] / "extension"
# Generic vectors and each site codec's own (src/background/codecs/<name>.vectors.json). fingerprint() runs the
# extension's code through harness/lib/fp_cli.mts, so this checks the bridge end to end.
VECTOR_FILES = [EXT / "fingerprint.vectors.json", *sorted((EXT / "src" / "background" / "codecs").glob("*.vectors.json"))]


class VectorTests(unittest.TestCase):
    def test_vectors(self):
        self.assertGreaterEqual(len(VECTOR_FILES), 6)
        for v in (v for f in VECTOR_FILES for v in json.loads(f.read_text())):
            with self.subTest(v["name"]):
                fp = fingerprint(v["method"], v["url"], v.get("contentType"), v.get("body"), v["hasBody"])
                self.assertEqual(fp.fingerprint, v["expected"])
                if "queryKeys" in v:
                    self.assertEqual(list(fp.query_keys), v["queryKeys"])



class RedactionVectorTests(unittest.TestCase):
    """Token redaction by value, shared with extension/src/background/fingerprint.ts."""

    def test_redaction_vectors(self):
        import json, os
        from state import redact_tokens
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "extension", "redaction.vectors.json")
        for v in json.load(open(path)):
            with self.subTest(v["input"][:40]):
                self.assertEqual(redact_tokens(v["input"]), v["expected"])


if __name__ == "__main__":
    unittest.main()

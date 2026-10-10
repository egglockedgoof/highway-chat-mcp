import unittest

from highway_mcp import ClientError, request_spec


class RequestSpec(unittest.TestCase):
    def test_bound_bearer_hits_bare_mcp(self):
        spec = request_spec("x" * 32, "https://highway-chat-mcp.onrender.com/")
        self.assertEqual(spec["url"], "https://highway-chat-mcp.onrender.com/mcp")
        self.assertEqual(spec["authorization"], "Bearer " + ("x" * 32))

    def test_missing_or_weak_token_fails_closed(self):
        for token in ("", "   ", "short"):
            with self.subTest(token=token):
                with self.assertRaises(ClientError) as ctx:
                    request_spec(token)
                self.assertIn("refuse path-legacy", str(ctx.exception))

    def test_never_embeds_path_secret(self):
        spec = request_spec("y" * 24, "https://example.test/bridge")
        self.assertEqual(spec["url"], "https://example.test/bridge/mcp")
        self.assertNotIn("secret", spec["url"])
        self.assertTrue(spec["authorization"].startswith("Bearer "))


if __name__ == "__main__":
    unittest.main()

"""Example approved script: reads its validated JSON input from argv and echoes it."""
import json
import sys

payload = json.loads(sys.argv[1])
print(json.dumps({"received": payload["message"]}))

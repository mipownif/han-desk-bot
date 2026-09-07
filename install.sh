#!/bin/bash
set -euo pipefail
python3 -c 'import urllib.request; urllib.request.urlretrieve("https://raw.githubusercontent.com/mipownif/han-desk-bot/main/install.py", "/tmp/han-install.py")'
python3 /tmp/han-install.py

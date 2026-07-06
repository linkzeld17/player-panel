SHELL := /usr/bin/env bash

.PHONY: test syntax package clean

syntax:
	find . -type f -name '*.sh' -not -path './dist/*' -print0 | sort -z | xargs -0 -n1 bash -n
	PYTHONPYCACHEPREFIX=/tmp/player-panel-pycache python3 -m py_compile components/web/app/server.py scripts/lib/crafty-server-discovery.py
	node --check components/web/app/static/app.js
	node --check integrations/bluemap/player-panel-bluemap-bridge-v6.js
	node --check integrations/squaremap/player-panel-squaremap-bridge-v7.js

test:
	chmod +x tests/*.sh tests/mock-docker scripts/lib/*.sh scripts/maps/*.sh
	./tests/test-package.sh

package:
	chmod +x scripts/package-release.sh
	./scripts/package-release.sh

clean:
	rm -rf dist
	find . -type d -name '__pycache__' -prune -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete

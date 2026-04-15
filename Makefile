SRC_DIR := multi-monitors-add-on@spin83
UUID := $(shell sed -n 's/.*"uuid":[[:space:]]*"\([^"]*\)".*/\1/p' $(SRC_DIR)/metadata.json)
BUILD_DIR := build
STAGE_DIR := $(BUILD_DIR)/$(UUID)
EXTENSION_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMAS_DIR := schemas
ARCHIVE := $(BUILD_DIR)/$(UUID).zip

.PHONY: check clean build package install enable disable

check:
	glib-compile-schemas --strict --dry-run $(SRC_DIR)/$(SCHEMAS_DIR)

clean:
	rm -rf $(BUILD_DIR)

build: check clean
	mkdir -p $(STAGE_DIR)/$(SCHEMAS_DIR)
	rsync -a --delete --exclude $(SCHEMAS_DIR)/gschemas.compiled $(SRC_DIR)/ $(STAGE_DIR)/
	glib-compile-schemas $(STAGE_DIR)/$(SCHEMAS_DIR)

package: build
	cd $(STAGE_DIR) && zip -qr ../../$(ARCHIVE) .

install: build
	if [ -L "$(EXTENSION_DIR)" ] && [ "$$(readlink -f "$(EXTENSION_DIR)")" = "$$(readlink -f "$(CURDIR)/$(SRC_DIR)")" ]; then rm "$(EXTENSION_DIR)"; fi
	mkdir -p $(EXTENSION_DIR)
	rsync -a --delete $(STAGE_DIR)/ $(EXTENSION_DIR)/

enable: install
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

UUID = ormic-launcher@github.com
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all build clean install uninstall dev-install lint lint-fix pack shexli

all: build

node_modules: package.json
	pnpm install

build: node_modules
	pnpm run build
	cp -r schemas dist/
	cp metadata.json dist/
	cp stylesheet.css dist/
	glib-compile-schemas dist/schemas/
	@echo "Build successful! Output is in the 'dist' directory."

install: build
	mkdir -p $(DEST)
	cp -r dist/* $(DEST)/
	@echo "Extension installed successfully to $(DEST)!"
	@echo "Please restart GNOME Shell (Alt+F2 -> r -> Enter on X11, or log out and log in on Wayland) and enable the extension."

dev-install: install
	@echo "Enabling extension..."
	gnome-extensions enable $(UUID)
	@echo "Tailing GNOME Shell logs for 'Ormic' (Ctrl+C to stop)..."
	journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i "ormic"

uninstall:
	rm -rf $(DEST)
	@echo "Extension uninstalled successfully."

lint: node_modules
	pnpm run lint

lint-fix: node_modules
	pnpm run lint:fix

pack: build
	@echo "Packaging extension..."
	rm -f dist/schemas/gschemas.compiled dist/patch.js dist/types.js dist/launcher/LauncherState.js
	rm -f $(UUID).zip
	cd dist && zip -qr ../$(UUID).zip *
	@echo "Package created: $(UUID).zip"

shexli: pack
	@echo "Running shexli on zip..."
	venv/bin/shexli $$(pwd)/$(UUID).zip

clean:
	rm -rf dist node_modules $(UUID).zip
	@echo "Cleaned build artifacts, node_modules, and zip files."


UUID = ormic-launcher@github.com
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all build clean install uninstall

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

uninstall:
	rm -rf $(DEST)
	@echo "Extension uninstalled successfully."

clean:
	rm -rf dist node_modules
	@echo "Cleaned build artifacts and node_modules."

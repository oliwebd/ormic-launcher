declare module 'gi://GMenu' {
    namespace GMenu {
        enum TreeItemType {
            INVALID = 0,
            DIRECTORY = 1,
            ENTRY = 2,
            SEPARATOR = 3,
            HEADER = 4,
            ALIAS = 5,
        }
        interface TreeIter {
            next(): TreeItemType;
            get_directory(): TreeDirectory | null;
            get_entry(): TreeEntry | null;
        }
        interface TreeDirectory {
            iter(): TreeIter;
            get_name(): string;
            get_is_nodisplay(): boolean;
        }
        interface TreeEntry {
            get_desktop_file_id(): string | null;
            get_app_info(): import('gi://Gio').default.AppInfo | null;
        }
        interface Tree extends import('gi://GObject').default.Object {
            load_sync(): boolean;
            get_root_directory(): TreeDirectory | null;
            connect(signal: 'changed', callback: () => void): number;
            disconnect(id: number): void;
        }
        interface TreeConstructorParams {
            menu_basename: string;
        }
        const Tree: {
            new(params: TreeConstructorParams): Tree;
        };
    }
    export default GMenu;
}

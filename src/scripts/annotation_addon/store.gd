@tool
extends RefCounted

const DIRECTORY = "res://.godot-mcp/annotations"
const VERSION = "1.0.2"
const MAX_PIXELS = 16777216
const MAX_IMAGE_BYTES = 8388608

static func data_directory() -> String:
    return ProjectSettings.globalize_path(DIRECTORY)

static func prepare() -> Error:
    var project = DirAccess.open("res://")
    if project == null or project.is_link(".godot-mcp"):
        return ERR_INVALID_PARAMETER
    if DirAccess.dir_exists_absolute(ProjectSettings.globalize_path("res://.godot-mcp")):
        var parent = DirAccess.open("res://.godot-mcp")
        if parent == null or parent.is_link("annotations") or parent.is_link(".gdignore") or parent.is_link(".gitignore"):
            return ERR_INVALID_PARAMETER
    var error = DirAccess.make_dir_recursive_absolute(data_directory())
    if error != OK:
        return error
    if not FileAccess.file_exists("res://.godot-mcp/.gdignore"):
        var ignore = FileAccess.open("res://.godot-mcp/.gdignore", FileAccess.WRITE)
        if ignore == null:
            return FileAccess.get_open_error()
        ignore.close()
    if not FileAccess.file_exists("res://.godot-mcp/.gitignore"):
        var gitignore = FileAccess.open("res://.godot-mcp/.gitignore", FileAccess.WRITE)
        if gitignore == null:
            return FileAccess.get_open_error()
        gitignore.store_string("*\n")
        gitignore.close()
    return OK

static func atomic_json(path: String, value: Dictionary) -> Error:
    var temporary = path + "." + str(OS.get_process_id()) + ".tmp"
    var parent = DirAccess.open(path.get_base_dir())
    if parent == null or parent.is_link(temporary.get_file()):
        return ERR_INVALID_PARAMETER
    var file = FileAccess.open(temporary, FileAccess.WRITE)
    if file == null:
        return FileAccess.get_open_error()
    file.store_string(JSON.stringify(value))
    file.close()
    var error = DirAccess.rename_absolute(temporary, path)
    if error != OK:
        DirAccess.remove_absolute(temporary)
    return error

static func presence(kind: String) -> void:
    if prepare() != OK:
        return
    atomic_json(data_directory().path_join(kind + "-" + str(OS.get_process_id()) + ".json"), {
        "schemaVersion": 1, "version": VERSION, "kind": kind,
        "pid": OS.get_process_id(), "updatedAt": Time.get_unix_time_from_system(),
        "sources": ["editor_2d", "editor_3d"] if kind == "editor" else ["runtime"]
    })

static func clear_presence(kind: String) -> void:
    DirAccess.remove_absolute(data_directory().path_join(kind + "-" + str(OS.get_process_id()) + ".json"))

static func submit(original: Image, marked: Image, context: Dictionary, annotations: Array) -> Dictionary:
    if original == null or original.is_empty() or annotations.is_empty() or annotations.size() > 100:
        return {"error": "Capture a frame and add 1 to 100 comments first."}
    if original.get_width() > 8192 or original.get_height() > 8192 or original.get_width() * original.get_height() > MAX_PIXELS:
        return {"error": "Capture exceeds the image size limit."}
    var original_bytes = original.save_png_to_buffer()
    var marked_bytes = marked.save_png_to_buffer()
    if original_bytes.size() > MAX_IMAGE_BYTES or marked_bytes.size() > MAX_IMAGE_BYTES:
        return {"error": "Capture exceeds the 8 MiB image limit."}
    if prepare() != OK:
        return {"error": "Cannot create local annotation storage."}
    var capture_id = Crypto.new().generate_random_bytes(16).hex_encode()
    var staging = data_directory().path_join(capture_id + ".tmp")
    if DirAccess.make_dir_absolute(staging) != OK:
        return {"error": "Cannot stage annotation capture."}
    for pair in [["original.png", original_bytes], ["marked.png", marked_bytes]]:
        var file = FileAccess.open(staging.path_join(pair[0]), FileAccess.WRITE)
        if file == null:
            cleanup_staging(staging)
            return {"error": "Cannot save capture image."}
        file.store_buffer(pair[1])
        file.close()
    var record = {
        "schemaVersion": 1, "captureId": capture_id,
        "source": context.get("source", "runtime"), "scenePath": context.get("scenePath", ""),
        "createdAt": Time.get_datetime_string_from_system(true) + "Z",
        "width": original.get_width(), "height": original.get_height(),
        "annotations": annotations.duplicate(true)
    }
    if JSON.stringify(record).to_utf8_buffer().size() > 524288:
        cleanup_staging(staging)
        return {"error": "Comments exceed the 512 KiB batch limit. Split them into smaller submissions."}
    if atomic_json(staging.path_join("record.json"), record) != OK or DirAccess.rename_absolute(staging, data_directory().path_join(capture_id)) != OK:
        cleanup_staging(staging)
        return {"error": "Cannot publish annotation capture."}
    return {"captureId": capture_id, "count": annotations.size()}

static func cleanup_staging(path: String) -> void:
    for name in DirAccess.get_files_at(path):
        DirAccess.remove_absolute(path.path_join(name))
    DirAccess.remove_absolute(path)

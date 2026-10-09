@tool
extends EditorPlugin

const PanelScene = preload("panel.tscn")
const Store = preload("store.gd")
const ExportGuard = preload("export_guard.gd")
var panel
var export_guard
var elapsed = 0.0

func _enter_tree() -> void:
    panel = PanelScene.instantiate()
    add_control_to_bottom_panel(panel, "Annotations")
    panel.configure(true)
    panel.capture_requested.connect(capture)
    panel.close_requested.connect(hide_bottom_panel)
    export_guard = ExportGuard.new()
    add_export_plugin(export_guard)
    Store.presence("editor")

func _process(delta: float) -> void:
    elapsed += delta
    if elapsed >= 5.0:
        elapsed = 0.0
        Store.presence("editor")

func _exit_tree() -> void:
    Store.clear_presence("editor")
    if is_instance_valid(panel):
        remove_control_from_bottom_panel(panel)
        panel.queue_free()
    if export_guard != null:
        remove_export_plugin(export_guard)

func capture(source: String) -> void:
    var viewport = EditorInterface.get_editor_viewport_2d() if source == "editor_2d" else EditorInterface.get_editor_viewport_3d(0)
    if viewport == null or DisplayServer.get_name() == "headless":
        panel.capture_failed("Open a rendered scene view before capturing.")
        return
    # Capture context before yielding; later scene selection cannot change it.
    var scene = EditorInterface.get_edited_scene_root()
    var metadata = {"source": source, "scenePath": scene.scene_file_path if scene != null else ""}
    await RenderingServer.frame_post_draw
    if not is_instance_valid(viewport) or not is_instance_valid(panel):
        return
    var image = viewport.get_texture().get_image()
    if image == null or image.is_empty():
        panel.capture_failed("The selected editor viewport has no rendered image.")
        return
    panel.set_capture(image, metadata)
    make_bottom_panel_item_visible(panel)

func _get_unsaved_status(_for_scene: String) -> String:
    return "MCP annotation comments have not been submitted." if is_instance_valid(panel) and panel.has_draft() else ""

func _run_scene(scene: String, args: PackedStringArray) -> PackedStringArray:
    # Do not replace another plugin's custom SceneTree.
    if "--script" in args or "-s" in args:
        return args
    var separator = args.find("--")
    var prefix = args.slice(0, separator) if separator >= 0 else args.duplicate()
    var user_args = args.slice(separator + 1) if separator >= 0 else PackedStringArray()
    prefix.append_array(["--script", ProjectSettings.globalize_path("res://addons/godot_mcp_annotations/game_session.gd"), "--"])
    prefix.append_array(user_args)
    prefix.append("--godot-mcp-annotation-scene=" + scene)
    return prefix

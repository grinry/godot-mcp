extends CanvasLayer

const Store = preload("store.gd")
var paused_before = false
var elapsed = 0.0

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    %AnnotationPanel.configure(false)
    %AnnotationPanel.capture_requested.connect(func(_source): capture())
    %AnnotationPanel.close_requested.connect(close_panel)
    %OpenAnnotations.pressed.connect(open_panel)
    %AnnotationModal.hide()
    Store.presence("runtime")

func _process(delta: float) -> void:
    elapsed += delta
    if elapsed >= 5.0:
        elapsed = 0.0
        Store.presence("runtime")

func _exit_tree() -> void:
    Store.clear_presence("runtime")

func open_panel() -> void:
    if %AnnotationModal.visible:
        return
    if %AnnotationPanel.has_draft():
        paused_before = get_tree().paused
        get_tree().paused = true
        %AnnotationModal.show()
        return
    await capture()

func capture() -> void:
    if DisplayServer.get_name() == "headless":
        %AnnotationPanel.capture_failed("A display renderer is required.")
        return
    var was_visible = %AnnotationModal.visible
    if not was_visible:
        paused_before = get_tree().paused
    get_tree().paused = true
    %AnnotationModal.hide()
    %OpenAnnotations.hide()
    var scene = get_tree().current_scene
    var metadata = {"source": "runtime", "scenePath": scene.scene_file_path if scene != null else ""}
    await RenderingServer.frame_post_draw
    var image = get_viewport().get_texture().get_image()
    %OpenAnnotations.show()
    if image == null or image.is_empty():
        %AnnotationPanel.capture_failed("The game viewport has no image.")
        get_tree().paused = paused_before
        return
    %AnnotationPanel.set_capture(image, metadata)
    %AnnotationModal.show()

func close_panel() -> void:
    %AnnotationModal.hide()
    get_tree().paused = paused_before

func _input(event: InputEvent) -> void:
    if %AnnotationModal.visible and not event is InputEventMouse and not event is InputEventKey:
        get_viewport().set_input_as_handled()

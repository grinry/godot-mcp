@tool
extends VBoxContainer

const Store = preload("store.gd")
signal capture_requested(source: String)
signal close_requested

@onready var canvas = %AnnotationCanvas
@onready var comment = %Comment
@onready var node_path = %NodePath
@onready var mark_list = %Marks
@onready var status = %Status
@onready var sources = %Sources
var context: Dictionary = {}
var pending_region: Dictionary = {}
var capture_busy = false
var dirty = false

func _ready() -> void:
    %Capture.pressed.connect(request_capture)
    %Close.pressed.connect(func(): close_requested.emit())
    %AddComment.pressed.connect(add_comment)
    %ClearDraft.pressed.connect(clear_pending)
    %Delete.pressed.connect(delete_mark)
    %Undo.pressed.connect(undo_mark)
    %Submit.pressed.connect(submit)
    %Kind.item_selected.connect(func(index): canvas.kind = "rectangle" if index == 0 else "pin")
    canvas.region_selected.connect(func(region): pending_region = region; comment.grab_focus(); status.text = "Write a comment, then click Add comment.")
    resized.connect(func(): canvas.queue_redraw())

func configure(editor: bool) -> void:
    sources.clear()
    if editor:
        sources.add_item("2D scene view")
        sources.add_item("3D scene view (viewport 1)")
    else:
        sources.add_item("Running game")

func has_draft() -> bool:
    return dirty or not pending_region.is_empty() or not comment.text.strip_edges().is_empty()

func clear_pending() -> void:
    pending_region.clear()
    canvas.draft_region.clear()
    canvas.queue_redraw()
    comment.text = ""
    node_path.text = ""
    status.text = "Pending region/comment cleared. Added comments were kept."

func request_capture() -> void:
    if has_draft():
        status.text = "Submit or delete your comments before capturing another frame."
        return
    if capture_busy:
        return
    capture_busy = true
    capture_requested.emit("runtime" if sources.get_item_text(0) == "Running game" else ("editor_2d" if sources.selected == 0 else "editor_3d"))

func capture_failed(message: String) -> void:
    capture_busy = false
    status.text = message

func set_capture(image: Image, metadata: Dictionary) -> void:
    capture_busy = false
    canvas.set_image(image)
    context = metadata.duplicate(true)
    mark_list.clear()
    pending_region.clear()
    comment.text = ""
    node_path.text = ""
    dirty = false
    status.text = "Draw a rectangle or choose Pin, then add a comment."

func add_comment() -> void:
    var text = comment.text.strip_edges()
    if pending_region.is_empty() or text.is_empty():
        status.text = "Select a region and write a comment first."
        return
    if text.length() > 4096 or node_path.text.length() > 4096 or canvas.marks.size() >= 100:
        status.text = "Limit: 100 comments, 4096 characters per comment or node path."
        return
    var mark = {"kind": canvas.draft_kind if not canvas.draft_region.is_empty() else canvas.kind, "region": pending_region.duplicate(), "comment": text}
    if not node_path.text.strip_edges().is_empty():
        mark.nodePath = node_path.text.strip_edges()
    canvas.marks.append(mark)
    dirty = true
    comment.text = ""
    pending_region.clear()
    canvas.draft_region.clear()
    refresh_list()

func refresh_list() -> void:
    mark_list.clear()
    for index in canvas.marks.size():
        mark_list.add_item(str(index + 1) + ": " + canvas.marks[index].comment)
    canvas.queue_redraw()

func delete_mark() -> void:
    var selected = mark_list.get_selected_items()
    if not selected.is_empty():
        canvas.marks.remove_at(selected[0])
        dirty = not canvas.marks.is_empty()
        refresh_list()

func undo_mark() -> void:
    if not canvas.marks.is_empty():
        canvas.marks.pop_back()
        dirty = not canvas.marks.is_empty()
        refresh_list()

func submit() -> void:
    if not comment.text.strip_edges().is_empty() or not pending_region.is_empty():
        status.text = "Add or clear the pending comment before submitting."
        return
    if not dirty or canvas.marks.is_empty():
        status.text = "Add comments before submitting."
        return
    var result = Store.submit(canvas.image, canvas.marked_image(), context, canvas.marks)
    if result.has("error"):
        status.text = result.error
        return
    dirty = false
    canvas.marks.clear()
    refresh_list()
    status.text = "Submitted %d comments. Ask your MCP client or agent to read Godot annotations. Capture: %s" % [result.count, result.captureId]

extends SceneTree

func _initialize() -> void:
    call_deferred("check_draft")

func near_color(image: Image, point: Vector2, expected: Color) -> bool:
    var center = Vector2i(point)
    for y in range(center.y - 2, center.y + 3):
        for x in range(center.x - 2, center.x + 3):
            if x >= 0 and y >= 0 and x < image.get_width() and y < image.get_height():
                if image.get_pixel(x, y).is_equal_approx(expected):
                    return true
    return false

func draw_region(canvas, first: Vector2, last: Vector2) -> void:
    var rect = canvas.image_rect()
    var event = InputEventMouseButton.new()
    event.button_index = MOUSE_BUTTON_LEFT
    event.pressed = true
    event.position = rect.position + first * rect.size
    canvas._gui_input(event)
    event.pressed = false
    event.position = rect.position + last * rect.size
    canvas._gui_input(event)

func check_draft() -> void:
    var panel = load(OS.get_cmdline_user_args()[0].path_join("panel.tscn")).instantiate()
    root.add_child(panel)
    panel.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
    panel.configure(false)
    var original = Image.create(320, 180, false, Image.FORMAT_RGB8)
    original.fill(Color.BLACK)
    panel.set_capture(original, {"source": "runtime", "scenePath": ""})
    await process_frame
    await process_frame
    var canvas = panel.get_node("AnnotationCanvas")
    draw_region(canvas, Vector2(0.25, 0.25), Vector2(0.75, 0.75))
    var rect = canvas.image_rect()
    var border = canvas.get_global_transform_with_canvas() * (rect.position + rect.size * Vector2(0.25, 0.5))
    await RenderingServer.frame_post_draw
    if not near_color(root.get_texture().get_image(), border, Color.YELLOW):
        push_error("Released draft rectangle must stay visible in yellow")
        quit(1)
        return
    panel.get_node("Comment").text = "Keep the pending rectangle visible"
    panel.add_comment()
    await RenderingServer.frame_post_draw
    if not near_color(root.get_texture().get_image(), border, Color.ORANGE_RED):
        push_error("Added comment must render the rectangle in red")
        quit(1)
        return
    draw_region(canvas, Vector2(0.1, 0.1), Vector2(0.4, 0.4))
    var draft_border = canvas.get_global_transform_with_canvas() * (rect.position + rect.size * Vector2(0.1, 0.2))
    await RenderingServer.frame_post_draw
    if not near_color(root.get_texture().get_image(), draft_border, Color.YELLOW):
        push_error("Replacement pending rectangle must be visible")
        quit(1)
        return
    panel.clear_pending()
    await RenderingServer.frame_post_draw
    if near_color(root.get_texture().get_image(), draft_border, Color.YELLOW):
        push_error("Clear draft must remove the yellow pending rectangle")
        quit(1)
        return
    if not near_color(root.get_texture().get_image(), border, Color.ORANGE_RED):
        push_error("Clear draft must preserve added red rectangles")
        quit(1)
        return
    canvas.kind = "pin"
    draw_region(canvas, Vector2(0.1, 0.2), Vector2(0.1, 0.2))
    var pin = canvas.get_global_transform_with_canvas() * (rect.position + rect.size * Vector2(0.1, 0.2))
    await RenderingServer.frame_post_draw
    if not near_color(root.get_texture().get_image(), pin, Color.YELLOW):
        push_error("Released draft pin must stay visible in yellow")
        quit(1)
        return
    panel.clear_pending()
    panel.queue_free()
    await process_frame
    print("ANNOTATION_DRAFT_RENDER_OK")
    quit(0)

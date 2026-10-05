# One-shot capture inspired by upstream PR #100. No project files are changed.
extends SceneTree

func _initialize():
    call_deferred("capture")

func capture():
    var args = OS.get_cmdline_user_args()
    if args.size() != 3:
        printerr("Expected scene, output PNG, and frame count")
        quit(1)
        return
    var packed = load(args[0])
    if not packed is PackedScene:
        printerr("Scene is not a PackedScene")
        quit(1)
        return
    var scene = packed.instantiate()
    root.add_child(scene)
    current_scene = scene
    for frame in range(int(args[2])):
        await process_frame
    await RenderingServer.frame_post_draw
    var image = root.get_texture().get_image()
    if image == null or image.is_empty():
        printerr("Viewport produced no image; a display renderer is required")
        quit(1)
        return
    var error = image.save_png(args[1])
    quit(0 if error == OK else 1)

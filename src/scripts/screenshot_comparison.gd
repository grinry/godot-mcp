extends SceneTree

func fail(message):
    printerr(message)
    quit(1)

func load_image(path):
    var image = Image.new()
    if image.load(path) != OK or image.is_empty():
        return null
    if image.get_width() > 4096 or image.get_height() > 4096 or image.get_width() * image.get_height() > 4000000:
        return null
    image.convert(Image.FORMAT_RGBA8)
    return image

func result(data):
    print("GODOT_MCP_RESULT " + JSON.stringify(data))
    quit(0)

func _init():
    var args = OS.get_cmdline_user_args()
    if args.size() != 2:
        fail("Expected operation and JSON")
        return
    var params = JSON.parse_string(args[1])
    if args[0] == "validate":
        for path in params.paths:
            if load_image(path) == null:
                fail("Baseline is not a decodable PNG within image limits")
                return
        result({"validated": true})
        return
    var baseline = load_image(params.baselinePath)
    var actual = load_image(params.actualPath)
    if baseline == null or actual == null:
        fail("Cannot decode screenshot PNG")
        return
    var width = actual.get_width()
    var height = actual.get_height()
    if baseline.get_width() != width or baseline.get_height() != height:
        result({"passed": false, "code": "IMAGE_DIMENSION_MISMATCH", "error": "Screenshot and baseline dimensions differ; images are not resized", "width": width, "height": height, "baselineWidth": baseline.get_width(), "baselineHeight": baseline.get_height()})
        return
    var left = baseline.get_data()
    var right = actual.get_data()
    var pixels = width * height
    var changed = 0
    var maximum = 0
    var diff = PackedByteArray()
    diff.resize(pixels * 4)
    for pixel in pixels:
        var offset = pixel * 4
        var delta = 0
        for channel in 4:
            delta = maxi(delta, absi(int(left[offset + channel]) - int(right[offset + channel])))
        maximum = maxi(maximum, delta)
        if delta > params.pixelTolerance:
            changed += 1
            diff[offset] = 255
            diff[offset + 1] = 0
            diff[offset + 2] = 255
        else:
            var gray = int((int(right[offset]) + int(right[offset + 1]) + int(right[offset + 2])) / 6.0)
            diff[offset] = gray
            diff[offset + 1] = gray
            diff[offset + 2] = gray
        diff[offset + 3] = 255
    var ratio = float(changed) / pixels
    var image = Image.create_from_data(width, height, false, Image.FORMAT_RGBA8, diff)
    if image.save_png(params.diffPath) != OK:
        fail("Cannot save diff image")
        return
    result({"passed": ratio <= params.maxChangedRatio, "width": width, "height": height, "totalPixels": pixels, "changedPixels": changed, "changedRatio": ratio, "changedPercentage": ratio * 100.0, "maxChannelDelta": maximum})

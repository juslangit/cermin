"""Flatten glTF's simple PBR texture math to image links the FBX writer reads.
Blender's FBX exporter ignores Mix and Separate Color nodes, losing colour maps.
"""
import bpy
import numpy as np


def image_link(socket):
    if not socket.is_linked:
        return None
    node = socket.links[0].from_node
    if node.type == 'TEX_IMAGE':
        return node
    for input in node.inputs:
        result = image_link(input)
        if result:
            return result
    return None


def pixels_image(source, name, multiply=None, channel=None):
    width, height = source.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    source.pixels.foreach_get(pixels)
    pixels = pixels.reshape((-1, 4))
    if channel is not None:
        value = pixels[:, channel].copy()
        pixels[:, :3] = value[:, None]
        pixels[:, 3] = 1
    if multiply is not None:
        pixels[:, :3] *= np.array(multiply[:3], dtype=np.float32)
    image = bpy.data.images.new(name, width, height, alpha=True)
    image.colorspace_settings.name = 'Non-Color' if channel is not None else source.colorspace_settings.name
    image.pixels.foreach_set(pixels.ravel())
    image.pack()
    return image


def prepare(material):
    if not material or not material.use_nodes:
        return
    tree = material.node_tree
    shader = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not shader:
        return
    for key in ['Base Color', 'Roughness', 'Metallic']:
        socket = shader.inputs[key]
        if not socket.is_linked:
            continue
        link = socket.links[0]
        node = link.from_node
        original = image_link(socket)
        if not original or not original.image or node.type == 'TEX_IMAGE':
            continue
        image = None
        if key == 'Base Color' and node.type in {'MIX', 'MIX_RGB'} and node.blend_type == 'MULTIPLY':
            factors = [i.default_value[:] for i in node.inputs
                       if i.type == 'RGBA' and not i.is_linked]
            factor = np.prod(np.array(factors), axis=0) if factors else [1, 1, 1, 1]
            image = pixels_image(original.image, material.name + '_base', multiply=factor)
        elif key in {'Roughness', 'Metallic'} and node.type in {'SEPARATE_COLOR', 'SEPRGB'}:
            channel = {'Red': 0, 'R': 0, 'Green': 1, 'G': 1, 'Blue': 2, 'B': 2}[link.from_socket.name]
            image = pixels_image(original.image, material.name + '_' + key.lower(), channel=channel)
        if image:
            texture = tree.nodes.new('ShaderNodeTexImage')
            texture.image = image
            texture.interpolation = original.interpolation
            if original.inputs['Vector'].is_linked:
                tree.links.new(original.inputs['Vector'].links[0].from_socket, texture.inputs['Vector'])
            tree.links.new(texture.outputs['Color'], socket)

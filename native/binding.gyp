{
  "targets": [
    {
      "target_name": "keyhook",
      "sources": [ "keyhook.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [ "-lUser32" ]
        }]
      ]
    }
  ]
}

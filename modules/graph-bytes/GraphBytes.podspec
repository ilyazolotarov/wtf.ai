absolute_react_native_path = File.dirname(`node --print "require.resolve('react-native/package.json')"`)
unless defined?(install_modules_dependencies)
  # Defined in react_native_pods.rb, which `pod ipc spec` doesn't load.
  require File.join(absolute_react_native_path, "scripts/react_native_pods")
end

# At the module's root, not in ios/: the C++ in cpp/ is shared with Android.
Pod::Spec.new do |s|
  s.name           = 'GraphBytes'
  s.version        = '1.0.0'
  s.summary        = 'Random access file reads for JavaScript on worker runtimes'
  s.description    = 'Random access file reads for JavaScript on worker runtimes: the navigator reads its road graph'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The JSI headers, from React Native built from source or prebuilt.
  install_modules_dependencies(s)

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }

  s.source_files = "ios/**/*.{h,mm,swift}", "cpp/**/*.{h,cpp}"
  # Swift sees the Objective-C installer only; the C++ header stays out of the module's umbrella.
  s.public_header_files = "ios/**/*.h"
end

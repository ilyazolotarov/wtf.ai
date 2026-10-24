Pod::Spec.new do |s|
  # Its Swift module can't be called CarPlay: that is Apple's framework, which it imports.
  s.name           = 'WtfCarPlay'
  s.version        = '1.0.0'
  s.summary        = 'The map and the route guidance on a CarPlay screen'
  s.description    = 'The map and the route guidance on a CarPlay screen'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CarPlay', 'MapKit'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

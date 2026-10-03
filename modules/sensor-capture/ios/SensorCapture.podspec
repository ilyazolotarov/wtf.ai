Pod::Spec.new do |s|
  s.name           = 'SensorCapture'
  s.version        = '1.0.0'
  s.summary        = 'CoreLocation + CoreMotion capture for trip logs'
  s.description    = 'CoreLocation + CoreMotion capture for trip logs'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreLocation', 'CoreMotion'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

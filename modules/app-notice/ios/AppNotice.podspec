Pod::Spec.new do |s|
  s.name           = 'AppNotice'
  s.version        = '1.0.0'
  s.summary        = 'The app\'s own notices: whether this copy came from TestFlight'
  s.description    = 'The app\'s own notices: whether this copy came from TestFlight'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'StoreKit'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

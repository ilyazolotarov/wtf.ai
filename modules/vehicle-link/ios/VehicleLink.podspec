Pod::Spec.new do |s|
  s.name           = 'VehicleLink'
  s.version        = '1.0.0'
  s.summary        = 'Thin BLE + MFi transport for ELM327 OBD-II adapters'
  s.description    = 'Thin BLE + MFi transport for ELM327 OBD-II adapters'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth', 'ExternalAccessory'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

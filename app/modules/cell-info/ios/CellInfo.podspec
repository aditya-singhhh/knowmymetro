Pod::Spec.new do |s|
  s.name           = 'CellInfo'
  s.version        = '0.1.0'
  s.summary        = 'Mobile tower readings for the KnowMyMetro trip recorder'
  s.description    = 'Returns no data on iOS; Android reads serving and neighbouring cells.'
  s.author         = 'KnowMyMetro'
  s.homepage       = 'https://github.com/aditya-singhhh/knowmymetro'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end

#include "hands-screen.h"
#include <iostream>
int main() {
  const std::string result = sarascreen::policyConformance();
  std::cout << result << std::endl;
  return result.find("\"ok\":false") == std::string::npos ? 0 : 1;
}

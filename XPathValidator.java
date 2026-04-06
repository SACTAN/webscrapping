package org.example;

import javax.xml.xpath.XPath;
import javax.xml.xpath.XPathFactory;
import javax.xml.xpath.XPathExpressionException;

public class XPathValidator {
    public static boolean isValid(String xpathExpression) {
        try {
            XPathFactory xpathFactory = XPathFactory.newInstance();
            XPath xpath = xpathFactory.newXPath();
            xpath.compile(xpathExpression); // Compiles to check syntax
            return true;
        } catch (XPathExpressionException e) {
            return false; // Returns false if XPath is invalid
        }
    }
}


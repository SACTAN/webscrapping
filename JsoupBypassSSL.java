
package org.example;

import org.jsoup.Connection;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import us.codecraft.xsoup.XPathEvaluator;
import us.codecraft.xsoup.Xsoup;

import javax.net.ssl.*;
import java.io.BufferedWriter;
import java.io.FileWriter;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.List;

import static org.jsoup.Jsoup.parse;

public class JsoupBypassSSL {

    public static void main(String[] args) throws Exception {

        SSLContext sslContext = SSLContext.getInstance("TLS");

        TrustManager[] trustAllCerts = new TrustManager[]{
                new X509TrustManager() {
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {
                    }

                    public void checkServerTrusted(X509Certificate[] chain, String authType) {
                    }

                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                }
        };

        sslContext.init(null, trustAllCerts, new SecureRandom());

        // Create SSL socket factory
        SSLSocketFactory sslSocketFactory = sslContext.getSocketFactory();

        Connection connection = Jsoup.connect("https://mvnrepository.com")
                .sslSocketFactory(sslSocketFactory)  // <‑‑ override SSL completely
                .ignoreHttpErrors(true)
                .ignoreContentType(true);

        String dir = System.getProperty("user.dir");
        System.out.println("user_directory" + dir);

        //String html = connection.get().html();
        String html = connection.get().outerHtml();
        //String title = connection.get().title().replaceAll("/","");
        String title = connection.get().title().replaceAll("[^A-Za-z]", "");
        System.out.println("Title of the page is: "+title);
        Document document = parse(html);
        System.out.println(html);

        //Store file in one place
        String filePath = dir+"/src/test/java/htmlfiles/"+title + ".html";

        try (BufferedWriter writer = new BufferedWriter(new FileWriter(filePath))) {
            writer.write(html);
            System.out.println("HTML content saved successfully to: " + filePath);
            //Step1 todo : To capture locators in Hashmap with LLM and tool
            //Step2: Iterate over the locators and verify if its exist in current page.
            //Xsoup.compile("//a");
            Boolean flag = XPathValidator.isValid("");
            //validated xpath is written to json file.
            // then that json file is used in



//            String result = Xsoup.compile("//a/@href").evaluate(document).get();
//            System.out.println("https://github.com :equal to " +  result);
//
//            List<String> list = Xsoup.compile("//tr/td/text()").evaluate(document).list();
//            System.out.println("a : = "+ list.get(0));
//            System.out.println("b : = "+ list.get(1));
        }
    }
}
